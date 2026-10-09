import type { EngineInterface, Register } from 'claude-code'
import { expectedFamily, lastModel, planFor, transcriptDir } from './rules'

// 親が子からのメッセージ (起動報告など) を受けたら、自分が起動した子を見直し、
// タイトル規約と違うモデルの子を set_session_model で切り替える。
// (set_session_model は自分自身には効かないので、起動元の親から直す。
//  自分が起動した子を同じか安いモデルへ変えるのは、通常は確認なしで通る)
// - 今のモデルは transcript の最後の応答から読む (get_session の model は claude.ai 側の切り替えを拾わない)
// - 1 つの子につき判定は 1 回 (期待どおり / 切り替えた / 失敗)。以後は手で変えたものを尊重する
const SERVER = 'ccd_session_mgmt'

type Row = { sessionId: string; title?: string; cwd?: string; isArchived?: boolean; startedBy?: string }

const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.find(c => c.type === 'text')?.text ?? ''

export const register: Register = on => {
  let isBusy = false

  // 読み込まれた印 (子からメッセージが来るまで何もしないので、これが無いと入ったか分からない)
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    $.ui.status('model-by-title')
    return result
  })

  on('session.receive', { origin: { kind: 'peer' } }, async ($, e, next) => {
    const result = await next(e)
    if (isBusy) return result
    isBusy = true
    try {
      const home = (await $.env.get('HOME')) ?? ''
      const rows = JSON.parse(textOf(await $.mcp.call(SERVER, 'list_sessions', { linked: true, limit: 50 }))) as Row[]
      for (const row of rows) {
        if (row.isArchived || !row.cwd || expectedFamily(row.title) === null) continue
        const key = `settled:${row.sessionId}`
        if (await $.store.get(key)) continue

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
    return result
  })
}

// 応答がまだ無い (起動直後) なら undefined。次のメッセージでもう一度見る
const currentModel = async ($: EngineInterface, dir: string) => {
  if (!(await $.fs.exists(dir))) return undefined
  const newest = (await $.fs.list(dir))
    .filter(f => f.kind === 'file' && f.name.endsWith('.jsonl'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  return newest ? lastModel(await $.fs.read(`${dir}/${newest.name}`)) : undefined
}

const log = async ($: EngineInterface, line: string) => {
  const prev = ((await $.store.get('log')) as string[] | undefined) ?? []
  await $.store.set('log', [...prev, `${new Date(await $.clock.now()).toISOString()} ${line}`].slice(-100))
}
