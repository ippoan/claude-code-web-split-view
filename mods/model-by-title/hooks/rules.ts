// タイトル規約 (ippoan/claude-skills task-split §1)。claude-code-web-split-view の content.js と同じ判定。
//   親:  #p<issue> <題>                                → Opus (Fable でも可)
//   子:  [S]/[O] #c<issue>-<n> <題>  /  [S]/[O] #p<issue>-c<子issue>(-<n>) <題>   (-<n> は再起票の連番)
//        [S] = Sonnet、それ以外 (= 既定) は Opus
//   [旧] #p… は旧親 (何もしない)。規約外も触らない
export type Family = 'sonnet' | 'opus'

export const cleanTitle = (t: string | undefined): string =>
  String(t ?? '').replace(/[\uE000-\uF8FF\u200B-\u200D\u2060\uFEFF]/g, '').replace(/\s+/g, ' ').trim()

export const expectedFamily = (title: string | undefined): Family | null => {
  const s = cleanTitle(title)
  const m0 = s.match(/^\[(S|O|旧)\]\s*/i)
  const tag = m0?.[1]?.toUpperCase() ?? null
  const rest = m0 ? s.slice(m0[0].length) : s
  if (tag === '旧') return null
  const tagged: Family = tag === 'S' ? 'sonnet' : 'opus'
  if (/^#p\d+-c\d+(?:-\d+)?(\s|$)/.test(rest) || /^#c\d+-\d+(?:-\d+)?(\s|$)/.test(rest)) return tagged
  if (/^#p\d+(\s|$)/.test(rest)) return 'opus'
  return tag ? tagged : null
}

// 期待どおりなら null、違えば差し替え先のモデル id
const OK: Record<Family, RegExp> = { sonnet: /sonnet/i, opus: /opus|fable/i }
const PICK: Record<Family, string> = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }

export const rewriteTo = (family: Family, model: string): string | null =>
  OK[family].test(model) ? null : PICK[family]

// 題とモデルから、切り替え先 (不要なら null) を出す
export const planFor = (title: string | undefined, model: string): string | null => {
  const family = expectedFamily(title)
  return family === null ? null : rewriteTo(family, model)
}

// transcript (jsonl) の置き場: ~/.claude/projects/<cwd の / と . を - にしたもの>
export const transcriptDir = (home: string, cwd: string): string =>
  `${home}/.claude/projects/${cwd.replace(/[/.]/g, '-')}`

// transcript の最後の assistant 応答のモデル。get_session の model は Remote Control 側の切り替えを拾わないので、こちらを正とする
export const lastModel = (jsonl: string): string | undefined => {
  const lines = jsonl.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line?.includes('"assistant"')) continue
    try {
      const row = JSON.parse(line) as { type?: string; message?: { model?: string } }
      if (row.type === 'assistant' && row.message?.model) return row.message.model
    } catch {
      // 書きかけの行は飛ばす
    }
  }
  return undefined
}
