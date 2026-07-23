import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertLocalUrl,
  assertSafeTestDatabase,
} from '../test-environment.js';

test('accepts loopback URLs only', () => {
  assert.equal(assertLocalUrl('http://localhost:3000', 'base').port, '3000');
  assert.throws(
    () => assertLocalUrl('https://hrms-be.example.com', 'base'),
    /must target localhost/,
  );
});

test('requires an explicitly named local test database', () => {
  assert.equal(
    assertSafeTestDatabase('postgresql://admin:password@127.0.0.1:5432/hrms_test'),
    'postgresql://admin:password@127.0.0.1:5432/hrms_test',
  );
  assert.throws(
    () => assertSafeTestDatabase('postgresql://admin:password@localhost:5432/hono_db'),
    /must contain "test"/,
  );
  assert.throws(
    () => assertSafeTestDatabase('postgresql://admin:password@db.example.com:5432/hrms_test'),
    /must target localhost/,
  );
});
