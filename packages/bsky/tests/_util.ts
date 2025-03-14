import { AtUri } from '@atproto/syntax'
import { lexToJson } from '@atproto/lexicon'
import { CID } from 'multiformats/cid'
import {
  FeedViewPost,
  PostView,
  isPostView,
  isThreadViewPost,
} from '../src/lexicon/types/app/bsky/feed/defs'
import { isViewRecord } from '../src/lexicon/types/app/bsky/embed/record'

// Swap out identifiers and dates with stable
// values for the purpose of snapshot testing
export const forSnapshot = (obj: unknown) => {
  const records = { [kTake]: 'record' }
  const collections = { [kTake]: 'collection' }
  const users = { [kTake]: 'user' }
  const cids = { [kTake]: 'cids' }
  const unknown = { [kTake]: 'unknown' }
  const toWalk = lexToJson(obj as any) // remove any blobrefs/cids
  return mapLeafValues(toWalk, (item) => {
    const asCid = CID.asCID(item)
    if (asCid !== null) {
      return take(cids, asCid.toString())
    }
    if (typeof item !== 'string') {
      return item
    }
    const str = item.startsWith('did:plc:') ? `at://${item}` : item
    if (str.startsWith('at://')) {
      const uri = new AtUri(str)
      if (uri.rkey) {
        return take(records, str)
      }
      if (uri.collection) {
        return take(collections, str)
      }
      if (uri.hostname) {
        return take(users, str)
      }
      return take(unknown, str)
    }
    if (str.match(/^\d{4}-\d{2}-\d{2}T/)) {
      if (str.match(/\d{6}Z$/)) {
        return constantDate.replace('Z', '000Z') // e.g. microseconds in record createdAt
      } else if (str.endsWith('+00:00')) {
        return constantDate.replace('Z', '+00:00') // e.g. timezone in record createdAt
      } else {
        return constantDate
      }
    }
    if (str.match(/^\d+__bafy/)) {
      return constantKeysetCursor
    }
    if (str.match(/\/img\/[^/]+\/.+\/did:plc:[^/]+\/[^/]+@[\w]+$/)) {
      // Match image urls
      const match = str.match(
        /\/img\/[^/]+\/.+\/(did:plc:[^/]+)\/([^/]+)@[\w]+$/,
      )
      if (!match) return str
      const [, did, cid] = match
      return str.replace(did, take(users, did)).replace(cid, take(cids, cid))
    }
    let isCid: boolean
    try {
      CID.parse(str)
      isCid = true
    } catch (_err) {
      isCid = false
    }
    if (isCid) {
      return take(cids, str)
    }
    return item
  })
}

// Feed testing utils

export const getOriginator = (item: FeedViewPost) => {
  if (!item.reason) {
    return item.post.author.did
  } else {
    return (item.reason.by as { [did: string]: string }).did
  }
}

// Useful for remapping ids in snapshot testing, to make snapshots deterministic.
// E.g. you may use this to map this:
//   [{ uri: 'did://rad'}, { uri: 'did://bad' }, { uri: 'did://rad'}]
// to this:
//   [{ uri: '0'}, { uri: '1' }, { uri: '0'}]
const kTake = Symbol('take')
export function take(obj, value: string): string
export function take(obj, value: string | undefined): string | undefined
export function take(
  obj: { [s: string]: number; [kTake]?: string },
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return
  }
  if (!(value in obj)) {
    obj[value] = Object.keys(obj).length
  }
  const kind = obj[kTake]
  return typeof kind === 'string'
    ? `${kind}(${obj[value]})`
    : String(obj[value])
}

export const constantDate = new Date(0).toISOString()
export const constantKeysetCursor = '0000000000000__bafycid'

const mapLeafValues = (obj: unknown, fn: (val: unknown) => unknown) => {
  if (Array.isArray(obj)) {
    return obj.map((item) => mapLeafValues(item, fn))
  }
  if (obj && typeof obj === 'object') {
    return Object.entries(obj).reduce(
      (collect, [name, value]) =>
        Object.assign(collect, { [name]: mapLeafValues(value, fn) }),
      {},
    )
  }
  return fn(obj)
}

export const paginateAll = async <T extends { cursor?: string }>(
  fn: (cursor?: string) => Promise<T>,
  limit = Infinity,
): Promise<T[]> => {
  const results: T[] = []
  let cursor
  do {
    const res = await fn(cursor)
    results.push(res)
    cursor = res.cursor
  } while (cursor && results.length < limit)
  return results
}

// @NOTE mutates
export const stripViewer = <T extends { viewer?: Record<string, unknown> }>(
  val: T,
): T => {
  delete val.viewer
  return val
}

// @NOTE mutates
export const stripViewerFromPost = (postUnknown: unknown): PostView => {
  if (postUnknown?.['$type'] && !isPostView(postUnknown)) {
    throw new Error('Expected post view')
  }
  const post = postUnknown as PostView
  post.author = stripViewer(post.author)
  const recordEmbed =
    post.embed && isViewRecord(post.embed.record)
      ? post.embed.record // Record from record embed
      : post.embed?.['record'] && isViewRecord(post.embed['record']['record'])
      ? post.embed['record']['record'] // Record from record-with-media embed
      : undefined
  if (recordEmbed) {
    recordEmbed.author = stripViewer(recordEmbed.author)
    recordEmbed.embeds?.forEach((deepEmbed) => {
      const deepRecordEmbed = isViewRecord(deepEmbed.record)
        ? deepEmbed.record // Record from record embed
        : deepEmbed['record'] && isViewRecord(deepEmbed['record']['record'])
        ? deepEmbed['record']['record'] // Record from record-with-media embed
        : undefined
      if (deepRecordEmbed) {
        deepRecordEmbed.author = stripViewer(deepRecordEmbed.author)
      }
    })
  }
  return stripViewer(post)
}

// @NOTE mutates
export const stripViewerFromThread = <T>(thread: T): T => {
  if (!isThreadViewPost(thread)) return thread
  delete thread.viewer
  thread.post = stripViewerFromPost(thread.post)
  if (isThreadViewPost(thread.parent)) {
    thread.parent = stripViewerFromThread(thread.parent)
  }
  if (thread.replies) {
    thread.replies = thread.replies.map(stripViewerFromThread)
  }
  return thread
}
