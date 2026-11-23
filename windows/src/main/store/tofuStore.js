/**
 * ZXDesk工作台 Windows 客户端
 */

import fs from 'node:fs';
import { normalizeFingerprint } from '../tls/tofu.js';

export class TofuStore {
  constructor(file, logger = () => {}) {
    this.file = file;
    this.logger = logger;
    this.records = readRecords(file);
  }

  get(host) {
    const record = this.records[String(host)];
    return record ? { ...record, sha256: normalizeFingerprint(record.sha256) } : null;
  }

  put(host, { subject, sha256, confirmedAt = Date.now() }) {
    this.records[String(host)] = { subject, sha256: normalizeFingerprint(sha256), confirmedAt };
    this.save();
  }

  forget(host) {
    delete this.records[String(host)];
    this.save();
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.records, null, 2), 'utf8');
    } catch (e) {
      this.logger(`TOFU 记录保存失败：${e.message}`);
    }
  }
}

function readRecords(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}
