import { test, expect } from 'claude-code/testing'
import { lastModel, planFor, transcriptDir } from '../hooks/rules'

test('[S] の子が Opus なら Sonnet へ', async () => {
  expect(planFor('[S] #p1193-c1 比較の画面', 'claude-opus-5-5')).toBe('claude-sonnet-5-5')
  expect(planFor('[S] #p1193-c1 比較の画面', 'claude-sonnet-5-5')).toBe(null)
})

test('親が Sonnet なら Opus へ、Fable はそのまま', async () => {
  expect(planFor('#p1193 監督', 'claude-sonnet-5-5')).toBe('claude-opus-5-5')
  expect(planFor('#p1193 監督', 'claude-fable-5-1')).toBe(null)
})

test('規約外・旧親は触らない', async () => {
  expect(planFor('ふつうの題', 'claude-opus-5-5')).toBe(null)
  expect(planFor('[旧] #p1193 旧親', 'claude-sonnet-5-5')).toBe(null)
})

test('transcript の置き場は cwd の / と . を - にした名前', async () => {
  expect(transcriptDir('/home/claude', '/home/claude/x/nuxt-dtako-admin/.claude/worktrees/funny-tu-8c5f97')).toBe(
    '/home/claude/.claude/projects/-home-claude-x-nuxt-dtako-admin--claude-worktrees-funny-tu-8c5f97',
  )
})

test('transcript の最後の assistant 応答のモデルを読む', async () => {
  const rows = [
    { type: 'assistant', message: { model: 'claude-opus-5-5' } },
    { type: 'user', message: { content: 'hi' } },
    { type: 'assistant', message: { model: 'claude-sonnet-5-5' } },
    { type: 'user', message: { content: 'next' } },
  ]
  expect(lastModel(rows.map(r => JSON.stringify(r)).join('\n') + '\n{"type":"assist')).toBe('claude-sonnet-5-5')
  expect(lastModel('{"type":"user"}\n')).toBe(undefined)
})
