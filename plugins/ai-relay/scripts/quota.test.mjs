// Grok 额度响应解析的单元测试：手工拼出 gRPC-web + protobuf 响应
import test from "node:test";
import assert from "node:assert/strict";
import { parseGrokCredits } from "./quota.mjs";

const varint = (n) => {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Buffer.from(out);
};
const tag = (field, wire) => varint(field * 8 + wire);
const msg = (field, body) => Buffer.concat([tag(field, 2), varint(body.length), body]);
const int = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);
const float = (field, f) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(f);
  return Buffer.concat([tag(field, 5), b]);
};
const frame = (flags, body) => {
  const head = Buffer.alloc(5);
  head[0] = flags;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
};
const start = 1793324820, end = start + 7 * 86400;
const period = (kind = 2) => Buffer.concat([int(1, kind), msg(2, int(1, start)), msg(3, int(1, end))]);
const response = (configParts) => frame(0, msg(1, Buffer.concat(configParts)));

test("解析已用百分比和周期", () => {
  const r = parseGrokCredits(response([float(1, 24), msg(8, period()), int(11, 1)]));
  assert.equal(Math.round(r.usedPercent), 24);
  assert.equal(r.periodStart, start * 1000);
  assert.equal(r.periodEnd, end * 1000);
});

test("统一周额度账户省略百分比时按 0 处理，其他账户按未知", () => {
  assert.equal(parseGrokCredits(response([msg(8, period()), int(11, 1)])).usedPercent, 0);
  assert.equal(parseGrokCredits(response([msg(8, period())])).usedPercent, null);
});

test("不是按周的周期、尾帧报错时抛错", () => {
  assert.throws(() => parseGrokCredits(response([msg(8, period(1))])), /不是按周/);
  const trailer = frame(0x80, Buffer.from("grpc-status: 16\r\n"));
  assert.throws(() => parseGrokCredits(Buffer.concat([response([msg(8, period())]), trailer])), /grpc-status 16/);
});
