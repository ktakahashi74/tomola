// Generated from Unicode 17.0.0 EastAsianWidth.txt (W and F only).
// https://www.unicode.org/Public/17.0.0/ucd/EastAsianWidth.txt
// Source SHA-256: ea7ce50f3444a050333448dffef1cadd9325af55cbb764b4a2280faf52170a33
// Copyright 2025 Unicode, Inc. Unicode License v3; see THIRD_PARTY_NOTICES.md.
// Base-36 gaps and spans keep the fixed table small in browser bundles.
export const WIDE_RANGES: readonly (readonly [number, number])[] = (() => {
  const values = "3cw.2n.3i2.1.d.1.5a.3.3.0.2.0.eh.1.l.1.q.7.g.b.17.0.a.5.3.0.d.0.8.1.h.1.5.1.8.0.5.0.l.0.7.1.1.0.4.0.2.0.7.0.4.1.s.0.z.0.1.0.4.2.1.0.1p.2.o.0.e.0.nv.1.1f.0.4.0.mi.p.1.2g.c.5x.q.26.2.2d.2.2u.5.16.1.2l.1.2d.9.1b.1.13.8.mkc.3.1i.wp.s.hv.8mb.6l8.e7.ls.9.m.y.1.i.1.3.45.2n.3j.6.m49.4.b.6.9.5p1.15.v.2p.36.6pp.3.1.6.1.1.1.82.f.0.t.2.2.0.e.3.8.az.6bo.2e.9.m.5n1.0.5m.0.5a.0.2.9.2t.2.d.17.4.8.7.1.e.5.4a.w.c.8.1.1x.1.l.c.16.4.4.c.g.3.0.3.1y.1.0.1.56.2.1q.d.3.1.n.i.0.q.1.d.0.2e.2c.1c.1x.6.0.3.2.2.3.3.3.b.1.7.8.6b.b.4.0.7v.1a.1.9.1.54.34.c.3.a.3.1k.1.0.4.f.2.b.4.9.zr.1ekd.2.1ekd".split(".").map(value => parseInt(value, 36));
  const ranges: [number, number][] = [];
  let previous = 0;
  for (let i = 0; i < values.length; i += 2) {
    const start = previous + values[i], end = start + values[i + 1];
    ranges.push([start, end]); previous = end + 1;
  }
  return ranges;
})();
