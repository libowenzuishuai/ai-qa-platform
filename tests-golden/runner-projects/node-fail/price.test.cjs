// Deliberate evaluator defect. Must be reported FAIL by the isolated runner.
const { test } = require('node:test');
const assert = require('node:assert/strict');
test('integer minor-unit total', () => assert.equal(1250 * 3, 3700));
