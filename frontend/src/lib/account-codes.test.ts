import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestCode } from './account-codes.ts';

test('suggestCode picks the next free number in the type range', () => {
	assert.equal(suggestCode([], 'expense'), '5000');
	assert.equal(suggestCode([{ code: '5000' }, { code: '5100' }], 'expense'), '5110');
	assert.equal(suggestCode([{ code: '1000' }, { code: '1005' }], 'asset'), '1010');
	assert.equal(suggestCode([{ code: '4000' }, { code: '5000' }, { code: 'CASH' }], 'revenue'), '4010');
	assert.equal(suggestCode([{ code: '2000' }, { code: '2990' }], 'liability'), '2001');
});
