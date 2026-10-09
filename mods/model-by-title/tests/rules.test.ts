import { test, expect } from 'claude-code/testing'
import { expectedFamily, rewriteTo } from '../hooks/rules'

test('タイトル規約から期待するモデル系統を読む', async () => {
  expect(expectedFamily('#p605 auth-worker')).toBe('opus')
  expect(expectedFamily('[S] #c605-2 テスト')).toBe('sonnet')
  expect(expectedFamily('[S] #p605-c610 子')).toBe('sonnet')
  expect(expectedFamily('[S] #p135-c211-2 再起票の子')).toBe('sonnet')
  expect(expectedFamily('[S] #c605-2-3 再起票の子')).toBe('sonnet')
  expect(expectedFamily('[O] #c605-3 子')).toBe('opus')
  expect(expectedFamily('#c605-3 タグ無し子')).toBe('opus')
  expect(expectedFamily('\uE07F\u200B[S] #c1-1 私用領域つき')).toBe('sonnet')
  expect(expectedFamily('[旧] #p605 旧親')).toBe(null)
  expect(expectedFamily('ふつうのセッション')).toBe(null)
  expect(expectedFamily(undefined)).toBe(null)
})

test('期待どおりなら差し替えない、違えば差し替え先を返す', async () => {
  expect(rewriteTo('sonnet', 'claude-sonnet-5-5')).toBe(null)
  expect(rewriteTo('sonnet', 'claude-opus-5-5')).toBe('claude-sonnet-5-5')
  expect(rewriteTo('opus', 'claude-fable-5-1')).toBe(null)
  expect(rewriteTo('opus', 'claude-sonnet-5-5')).toBe('claude-opus-5-5')
})
