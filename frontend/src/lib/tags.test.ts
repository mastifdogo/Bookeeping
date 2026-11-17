import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyTagForm, parseRateItem, tagBody, tagLabel } from './tags.ts';

test('rate items read description, quantity, rate', () => {
	assert.equal(tagLabel({ tag: 'rate', entity: null, description: 'Labour', quantity: 7.5, unit: 'hours', rate_cents: 8000 }), 'rate: Labour, 7.5 hours, 80.00 = 600.00');
	assert.equal(tagLabel({ tag: 'rate', entity: null, description: null, quantity: 3, unit: null, rate_cents: null }), 'rate: 3');
	assert.equal(tagLabel({ tag: 'paid', entity: null }), 'paid');
});

test('an item typed as description,quantity,rate', () => {
	assert.deepEqual(parseRateItem('Labour,7.5,80'), { description: 'Labour', quantity: '7.5', unit: '', rate: '80' });
	assert.deepEqual(parseRateItem('Parts, wiring, 3 items, $12.50'), { description: 'Parts, wiring', quantity: '3', unit: 'items', rate: '$12.50' });
	assert.equal(parseRateItem('Just words, more words, and more'), null);
	assert.equal(parseRateItem('Labour'), null);
	assert.deepEqual(tagBody({ ...emptyTagForm(), tag: 'rate', description: 'Labour, 7.5 hours, 80.00' }), { tag: 'rate', description: 'Labour', quantity: 7.5, unit: 'hours', rate_cents: 8000 });
	assert.deepEqual(tagBody({ ...emptyTagForm(), tag: 'rate', id: '12', description: 'Fuel', quantity: '40', unit: 'litres', rate: '1.65' }), { tag: 'rate', id: 12, description: 'Fuel', quantity: 40, unit: 'litres', rate_cents: 165 });
	assert.equal(typeof tagBody({ ...emptyTagForm(), tag: 'rate', description: 'Labour' }), 'string');
});
