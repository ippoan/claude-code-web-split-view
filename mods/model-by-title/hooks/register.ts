import type { EngineInterface, Register } from 'claude-code'
import { expectedFamily, lastModel, planFor, transcriptDir } from './rules'

// 親が子からのメッセージ (起動報告など) を受けたら、自分が起動した子を見直し、
// タイトル規約と違うモデルの子を set_session_model で切り替える。
// - きっかけ: デスクトップでは子の send_message は session.receive も prompt.submit も通らず、
//   classic.UserPromptSubmit の e.prompt に <cross-session-message …> を含む形で届く。
//   それを含むときだけ見直す (ユーザーの入力では動かさない)
// - set_session_model は自分自身には効かないので、起動元の親から直す。
//   mod からの呼び出しも auto mode の判定を通るので、permissions.allow に
//   mcp__ccd_session_mgmt__set_session_model が要る (README)
// - 今のモデルは transcript の最後の応答から読む (get_session の model は claude.ai 側の切り替えを拾わない)
// - 1 つの子につき判定は 1 回 (期待どおり / 切り替えた / 失敗)。以後は手で変えたものを尊重する
// - $ を渡す先は最上位の function (claude plugin validate の要件)。状態はモジュール変数に置く
const SERVER = 'ccd_session_mgmt'
const MARKER = '<' + 'cross-session-message'

type Row = { sessionId: string; title?: string; cwd?: string; isArchived?: boolean }
type Session = { sessionId?: string; parentSessionId?: string }

const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.find(c => c.type === 'text')?.text ?? ''

// MCP 結果のテキストは JSON の後ろに注記が付くことがある。最初の [ か { から最後の ] か } までを parse する
const parseJson = <T>(text: string): T => {
  const start = text.search(/[[{]/)
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'))
  return JSON.parse(text.slice(start, end + 1)) as T
}

let isBusy = false
const othersChildren = new Set<string>() // 他の親の子。get_session を毎回打たない

export const register: Register = on => {
  // 読み込まれた印 (子からメッセージが来るまで何もしないので、これが無いと入ったか分からない)
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    $.ui.status('model-by-title')
    return result
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (typeof e.prompt === 'string' && e.prompt.includes(MARKER)) await review($)
    return next(e)
  })
}

async function review($: EngineInterface) {
  if (isBusy) return
  isBusy = true
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const me = parseJson<Session>(textOf(await $.mcp.call(SERVER, 'get_session', { session_id: 'self' }))).sessionId
    // linked: true は start_session の家族だけで、spawn_task のチップから起動した子は入らない。
    // 全件から題で絞り、get_session の parentSessionId で自分の子か確かめる
    const rows = parseJson<Row[]>(textOf(await $.mcp.call(SERVER, 'list_sessions', { limit: 50 })))
    for (const row of rows) {
      if (row.isArchived || !row.cwd || expectedFamily(row.title) === null) continue
      const key = `settled:${row.sessionId}`
      if (othersChildren.has(row.sessionId) || (await $.store.get(key))) continue
      const info = parseJson<Session>(textOf(await $.mcp.call(SERVER, 'get_session', { session_id: row.sessionId })))
      if (!me) continue
      if (info.parentSessionId !== me) {
        othersChildren.add(row.sessionId)
        continue
      }

      const model = await currentModel($, transcriptDir(home, row.cwd))
      if (model === undefined) continue
      const to = planFor(row.title, model)
      if (to === null) {
        await $.store.set(key, 'ok')
        await log($, `ok ${model} ${row.title}`)
        continue
      }

      const r = await $.mcp.call(SERVER, 'set_session_model', { session_id: row.sessionId, model: to })
      await $.store.set(key, r.isError ? 'failed' : 'switched')
      await log($, `${r.isError ? 'failed' : 'switched'} ${model} → ${to} ${row.title}${r.isError ? ` :: ${textOf(r).slice(0, 200)}` : ''}`)
      $.ui.toast(r.isError ? `model-by-title: 切替失敗 ${row.title}` : `model-by-title: ${row.title} → ${to}`)
    }
  } catch (err) {
    await log($, `error ${String(err).slice(0, 200)}`)
  } finally {
    isBusy = false
  }
}

// 応答がまだ無い (起動直後) なら undefined。次のメッセージでもう一度見る
async function currentModel($: EngineInterface, dir: string) {
  if (!(await $.fs.exists(dir))) return undefined
  const newest = (await $.fs.list(dir))
    .filter(f => f.kind === 'file' && f.name.endsWith('.jsonl'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  return newest ? lastModel(await $.fs.read(`${dir}/${newest.name}`)) : undefined
}

async function log($: EngineInterface, line: string) {
  const prev = ((await $.store.get('log')) as string[] | undefined) ?? []
  await $.store.set('log', [...prev, `${new Date(await $.clock.now()).toISOString()} ${line}`].slice(-100))
}
