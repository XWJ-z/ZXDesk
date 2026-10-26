import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TRUST, decideTrust, isDeviceCertificate, normalizeFingerprint, parseSubject } from '../src/main/tls/tofu.js';

test('subject 按属性解析，不依赖顺序与空格（真机是 CN=fnOS,O=fnOS）', () => {
  assert.deepEqual(parseSubject('CN=fnOS,O=fnOS'), { CN: 'fnOS', O: 'fnOS' });
  assert.deepEqual(parseSubject('O=fnOS, CN=fnOS'), { O: 'fnOS', CN: 'fnOS' });
  assert.deepEqual(parseSubject('C=CN, O=fnOS, CN=fnOS, OU=dev'), { C: 'CN', O: 'fnOS', CN: 'fnOS', OU: 'dev' });
});

test('本设备证书：必须 O=fnOS 且 CN=fnOS', () => {
  assert.equal(isDeviceCertificate('CN=fnOS,O=fnOS'), true);
  assert.equal(isDeviceCertificate('CN=fnOS,O=fnOS,OU=x'), true);
  assert.equal(isDeviceCertificate('CN=fnOS'), false, '缺 O 不算');
  assert.equal(isDeviceCertificate('O=fnOS'), false, '缺 CN 不算');
  assert.equal(isDeviceCertificate('CN=other,O=fnOS'), false);
  assert.equal(isDeviceCertificate(''), false);
});

test('指纹归一：去冒号与空格、统一大写', () => {
  assert.equal(normalizeFingerprint('ab:cd:ef'), 'ABCDEF');
  assert.equal(normalizeFingerprint('ab cd ef'), 'ABCDEF');
  assert.equal(normalizeFingerprint(null), '');
});

const SHA = 'AA:BB:CC';

test('TOFU 分支一：非本设备证书 ⇒ 拒绝', () => {
  const verdict = decideTrust({ subject: 'CN=other,O=other', sha256: SHA }, null);
  assert.equal(verdict.decision, TRUST.REJECT);
});

test('TOFU 分支二：首次见过 ⇒ 询问', () => {
  const verdict = decideTrust({ subject: 'CN=fnOS,O=fnOS', sha256: SHA }, null);
  assert.equal(verdict.decision, TRUST.ASK);
  assert.equal(verdict.sha256, 'AABBCC');
});

test('TOFU 分支三：指纹一致 ⇒ 放行（大小写 / 冒号差异不算变化）', () => {
  const verdict = decideTrust({ subject: 'CN=fnOS,O=fnOS', sha256: 'aabbcc' }, { subject: 'CN=fnOS,O=fnOS', sha256: 'AA:BB:CC' });
  assert.equal(verdict.decision, TRUST.ACCEPT);
});

test('TOFU 分支四：指纹变了 ⇒ 按轮换重确认，并带上旧指纹', () => {
  const verdict = decideTrust({ subject: 'CN=fnOS,O=fnOS', sha256: 'DD:EE:FF' }, { subject: 'CN=fnOS,O=fnOS', sha256: 'AA:BB:CC' });
  assert.equal(verdict.decision, TRUST.ROTATED);
  assert.equal(verdict.previousSha256, 'AABBCC');
  assert.equal(verdict.sha256, 'DDEEFF');
});

test('subject 变了但指纹没变：仍然放行（指纹是真正判据）', () => {
  const verdict = decideTrust({ subject: 'CN=fnOS,O=fnOS,OU=x', sha256: SHA }, { subject: 'CN=fnOS,O=fnOS', sha256: SHA });
  assert.equal(verdict.decision, TRUST.ACCEPT);
});
