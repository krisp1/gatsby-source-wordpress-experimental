import { fluid } from "gatsby-plugin-sharp"
import Img from "gatsby-image"
import React from "react"
import ReactDOMServer from "react-dom/server"
import stringify from "fast-json-stable-stringify"
import execall from "execall"
import cheerio from "cheerio"

import createRemoteFileNode from "./create-remote-file-node/index"
import fetchReferencedMediaItemsAndCreateNodes, {
  stripImageSizesFromUrl,
} from "../fetch-nodes/fetch-referenced-media-items"
import store from "~/store"
import btoa from "btoa"

// @todo this doesn't make sense because these aren't all images
const imgSrcRemoteFileRegex = /(?:src=\\")((?:(?:https?|ftp|file):\/\/|www\.|ftp\.)(?:\([-A-Z0-9+&@#/%=~_|$?!:,.]*\)|[-A-Z0-9+&@#/%=~_|$?!:,.])*(?:\([-A-Z0-9+&@#/%=~_|$?!:,.]*\)|[A-Z0-9+&@#/%=~_|$])\.(?:xjpeg|jpg|png|gif|ico|pdf|doc|docx|ppt|pptx|pps|ppsx|odt|xls|psd|mp3|m4a|ogg|wav|mp4|m4v|mov|wmv|avi|mpg|ogv|3gp|3g2|svg|bmp|tif|tiff|asf|asx|wm|wmx|divx|flv|qt|mpe|webm|mkv|tt|asc|c|cc|h|csv|tsv|ics|rtx|css|htm|html|m4b|ra|ram|mid|midi|wax|mka|rtf|js|swf|class|tar|zip|gz|gzip|rar|7z|exe|pot|wri|xla|xlt|xlw|mdb|mpp|docm|dotx|dotm|xlsm|xlsb|xltx|xltm|xlam|pptm|ppsm|potx|potm|ppam|sldx|sldm|onetoc|onetoc2|onetmp|onepkg|odp|ods|odg|odc|odb|odf|wp|wpd|key|numbers|pages))(?=\\"| |\.)/gim

const imgTagRegex = /<img([\w\W]+?)[\/]?>/gim

const findReferencedImageNodeIds = ({
  nodeString,
  pluginOptions,
  referencedMediaItemNodeIds,
  node,
}) => {
  // if the lazyNodes plugin option is set we don't need to find
  // image node id's because those nodes will be fetched lazily in resolvers
  if (pluginOptions.type.MediaItem.lazyNodes) {
    return
  }

  // get an array of all referenced media file ID's
  const matchedIds = execall(/"id":"([^"]*)","sourceUrl"/gm, nodeString)
    .map((match) => match.subMatches[0])
    .filter((id) => id !== node.id)

  return matchedIds
}

const getCheerioImgDbId = (cheerioImg) => {
  // try to get the db id from data attributes
  const dataAttributeId =
    cheerioImg.attribs[`data-id`] || cheerioImg.attribs[`data-image-id`]

  if (dataAttributeId) {
    return dataAttributeId
  }

  if (!cheerioImg.attribs.class) {
    return null
  }

  // try to get the db id from the wp-image-id classname
  // const wpImageClass = cheerioImg.attribs.class
  //   .split(` `)
  //   .find((className) => className.includes(`wp-image-`))

  // if (wpImageClass) {
  //   const wpImageClassDashArray = wpImageClass.split(`-`)
  //   const wpImageClassId = Number(
  //     wpImageClassDashArray[wpImageClassDashArray.length - 1]
  //   )

  //   if (wpImageClassId) {
  //     return wpImageClassId
  //   }
  // }

  return null
}

const dbIdToMediaItemRelayId = (dbId) => (dbId ? btoa(`post:${dbId}`) : null)

const getCheerioImgRelayId = (cheerioImg) =>
  dbIdToMediaItemRelayId(getCheerioImgDbId(cheerioImg))

const fetchNodeHtmlImageMediaItemNodes = async ({
  cheerioImages,
  nodeString,
  node,
  helpers,
}) => {
  // check if we have any of these nodes locally already
  // build a query to fetch all media items that we don't already have
  const mediaItemUrls = cheerioImages.map(
    ({ cheerioImg }) => cheerioImg.attribs.src
  )

  const mediaItemNodesBySourceUrl = await fetchReferencedMediaItemsAndCreateNodes(
    {
      mediaItemUrls,
    }
  )

  // images that have been edited from the media library that were previously
  // uploaded to a post/page will have a different sourceUrl so they can't be fetched by it
  // in many cases we have data-id or data-image-id as attributes on the img
  // we can try to use those to fetch media item nodes as well
  // this will keep us from missing nodes
  const mediaItemDbIds = cheerioImages
    .map(({ cheerioImg }) => getCheerioImgDbId(cheerioImg))
    .filter(Boolean)

  // media items are of the post type
  const mediaItemRelayIds = mediaItemDbIds
    .map((dbId) => dbIdToMediaItemRelayId(dbId))
    .filter(
      // filter out any media item ids we already fetched
      (relayId) => !mediaItemNodesBySourceUrl.find(({ id }) => id === relayId)
    )

  const mediaItemNodesById = await fetchReferencedMediaItemsAndCreateNodes({
    referencedMediaItemNodeIds: mediaItemRelayIds,
  })

  const mediaItemNodes = [...mediaItemNodesById, ...mediaItemNodesBySourceUrl]

  const htmlMatchesToMediaItemNodesMap = new Map()
  for (const { cheerioImg, match } of cheerioImages) {
    const htmlImgSrc = cheerioImg.attribs.src

    const possibleHtmlSrcs = [
      // try to match the media item source url by original html src
      htmlImgSrc,
      // or by the src minus any image sizes string
      stripImageSizesFromUrl(htmlImgSrc),
    ]

    let imageNode = mediaItemNodes.find(
      (mediaItemNode) =>
        // either find our node by the source url
        possibleHtmlSrcs.includes(mediaItemNode.sourceUrl) ||
        // or by id for cases where the src url didn't return a node
        getCheerioImgRelayId(cheerioImg) === mediaItemNode.id
    )

    if (!imageNode && htmlImgSrc) {
      // if we didn't get a media item node for this image,
      // we need to fetch it and create a file node for it with no
      // media item node.
      imageNode = await createRemoteFileNode({
        url: htmlImgSrc,
        // fixedBarTotal,
        parentNodeId: node.id,
        ...helpers,
        createNode: helpers.actions.createNode,
      })
    }

    if (imageNode) {
      // match is the html string of the img tag
      htmlMatchesToMediaItemNodesMap.set(match, { imageNode, cheerioImg })
    }
  }

  return htmlMatchesToMediaItemNodesMap
}

const getCheerioImgFromMatch = ({ match }) => {
  // unescape quotes
  const parsedMatch = JSON.parse(`"${match}"`)

  // load our matching img tag into cheerio
  const $ = cheerio.load(parsedMatch, {
    xml: {
      // make sure it's not wrapped in <body></body>
      withDomLvl1: false,
      // no need to normalize whitespace, we're dealing with a single element here
      normalizeWhitespace: false,
      xmlMode: true,
      // entity decoding isn't our job here, that will be the responsibility of WPGQL
      // or of the source plugin elsewhere.
      decodeEntities: false,
    },
  })

  // there's only ever one image due to our match matching a single img tag
  // $(`img`) isn't an array, it's an object with a key of 0
  const cheerioImg = $(`img`)[0]

  return {
    match,
    cheerioImg,
  }
}

const getLargestSizeFromSizesAttribute = (sizesString) => {
  const sizesStringsArray = sizesString.split(`,`)

  return sizesStringsArray.reduce((largest, currentSizeString) => {
    const maxWidth = currentSizeString
      .substring(
        currentSizeString.indexOf(`max-width: `) + 1,
        currentSizeString.indexOf(`px`)
      )
      .trim()

    const maxWidthNumber = Number(maxWidth)
    const noLargestAndMaxWidthIsANumber = !largest && !isNaN(maxWidthNumber)
    const maxWidthIsALargerNumberThanLargest =
      largest && !isNaN(maxWidthNumber) && maxWidthNumber > largest

    if (noLargestAndMaxWidthIsANumber || maxWidthIsALargerNumberThanLargest) {
      largest = maxWidthNumber
    }

    return largest
  }, null)
}

const findImgTagMaxWidthFromCheerioImg = (cheerioImg) => {
  const {
    attribs: { width, sizes },
  } = cheerioImg || { attribs: { width: null, sizes: null } }

  if (width) {
    const widthNumber = Number(width)

    if (!isNaN(widthNumber)) {
      return width
    }
  }

  if (sizes) {
    const largestSize = getLargestSizeFromSizesAttribute(sizes)

    if (largestSize && !isNaN(largestSize)) {
      return largestSize
    }
  }

  return null
}

const replaceNodeHtmlImages = async ({
  nodeString,
  node,
  helpers,
  wpUrl,
  // pluginOptions,
}) => {
  const imageUrlMatches = execall(imgSrcRemoteFileRegex, nodeString)
  const imgTagMatches = execall(imgTagRegex, nodeString).filter(({ match }) =>
    // @todo make it a plugin option to fetch non-wp images
    // here we're filtering out image tags that don't contain our site url
    match.includes(wpUrl)
  )

  if (imageUrlMatches.length) {
    const cheerioImages = imgTagMatches.map(getCheerioImgFromMatch)

    const htmlMatchesToMediaItemNodesMap = await fetchNodeHtmlImageMediaItemNodes(
      {
        cheerioImages,
        nodeString,
        node,
        helpers,
      }
    )

    // generate gatsby images for each cheerioImage
    const htmlMatchesWithImageResizes = await Promise.all(
      imgTagMatches.map(async ({ match }) => {
        const { imageNode, cheerioImg } = htmlMatchesToMediaItemNodesMap.get(
          match
        )

        const isMediaItemNode = imageNode.__typename === `MediaItem`

        if (!imageNode) {
          return null
        }

        const fileNode =
          // if we couldn't get a MediaItem node for this image in WPGQL
          !isMediaItemNode
            ? // this will already be a file node
              imageNode
            : // otherwise grab the file node
              helpers.getNode(imageNode.localFile.id)

        const imgTagMaxWidth = findImgTagMaxWidthFromCheerioImg(cheerioImg)
        const mediaItemNodeWidth = isMediaItemNode
          ? imageNode?.mediaDetails?.width
          : null

        const maxWidth =
          (mediaItemNodeWidth && mediaItemNodeWidth < imgTagMaxWidth
            ? mediaItemNodeWidth
            : // @todo add plugin option to configure default maxWidth
              imgTagMaxWidth) ?? 800

        const fluidResult = await fluid({
          file: fileNode,
          args: {
            maxWidth,
            // @todo add plugin option to control quality
          },
          reporter: helpers.reporter,
          cache: helpers.cache,
        })

        return {
          match,
          cheerioImg,
          fileNode,
          imageResize: fluidResult,
        }
      })
    )

    // find/replace mutate nodeString to replace matched images with rendered gatsby images
    for (const {
      match,
      imageResize,
      cheerioImg,
    } of htmlMatchesWithImageResizes) {
      // @todo retain img tag classes and attributes from cheerioImg
      const imgOptions = {
        fluid: imageResize,
        style: {
          maxWidth: "100%",
        },
        // // Force show full image instantly
        // // critical: true, // depricated
        // loading: "eager",
        // alt: formattedImgTag.alt,
        // // fadeIn: true,
        // imgStyle: {
        //   opacity: 1,
        // },
      }

      const ReactGatsbyImage = React.createElement(Img, imgOptions, null)
      const gatsbyImageStringJSON = JSON.stringify(
        ReactDOMServer.renderToString(ReactGatsbyImage)
      )

      // need to remove the JSON stringify quotes around our image since we're
      // threading this JSON string back into a larger JSON object string
      const gatsbyImageString = gatsbyImageStringJSON.substring(
        1,
        gatsbyImageStringJSON.length - 1
      )

      // replace match with react string in nodeString
      nodeString = nodeString.replace(match, gatsbyImageString)
    }

    store.dispatch.imageNodes.addImgMatches(imageUrlMatches)
  }

  return nodeString
}

const processNodeString = async ({
  nodeString,
  node,
  pluginOptions,
  helpers,
  wpUrl,
}) => {
  // const nodeStringFilters = [replaceNodeHtmlImages,]
  const nodeStringWithGatsbyImages = replaceNodeHtmlImages({
    nodeString,
    node,
    pluginOptions,
    helpers,
    wpUrl,
  })

  // const mediaItemNodes = await helpers.getNodesByType(`WpMediaItem`)
  // dd(mediaItemNodes)

  // const nodeStringWithGatsbyImagesAndRelativeLinks = replaceNodeHtmlLinks({
  //   nodeString,
  //   pluginOptions,
  // })
  // return nodeStringWithGatsbyImagesAndRelativeLinks

  return nodeStringWithGatsbyImages
}

const processNode = async ({
  node,
  pluginOptions,
  referencedMediaItemNodeIds,
  wpUrl,
  helpers,
}) => {
  const anchorTagRegex = new RegExp(
    // eslint-disable-next-line no-useless-escape
    `<a[\\\s]+[^>]*?href[\\\s]?=["'\\\\]*(${wpUrl}.*?)["'\\\\]*.*?>([^<]+|.*?)?<\/a>`,
    `gim`
  )

  const nodeString = stringify(node)

  // find referenced node ids
  const nodeMediaItemIdReferences = findReferencedImageNodeIds({
    nodeString,
    pluginOptions,
    node,
  })

  // push them to our store of referenced id's
  if (nodeMediaItemIdReferences.length) {
    nodeMediaItemIdReferences.forEach((id) =>
      referencedMediaItemNodeIds.add(id)
    )
  }

  const processedNodeString = await processNodeString({
    nodeString,
    node,
    pluginOptions,
    helpers,
    wpUrl,
  })

  // only parse if the nodeString has changed
  if (processedNodeString !== nodeString) {
    try {
      return JSON.parse(processedNodeString)
    } catch (e) {
      dump(processedNodeString)
      helpers.reporter.panic(e)
    }
  } else {
    return node
  }
}

export { processNode }