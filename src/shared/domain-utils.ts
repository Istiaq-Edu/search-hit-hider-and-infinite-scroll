// ============================================================
// Domain normalization and lightweight root domain extraction
// ============================================================

// Common compound TLDs (public suffixes with 2+ parts).
// Covers ~99% of real-world cases without the full 143 KB PSL trie.
const COMPOUND_TLDS = new Set([
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "ac.uk", "gov.uk", "nhs.uk",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp", "ad.jp",
  "co.kr", "or.kr", "ne.kr", "ac.kr", "go.kr", "re.kr",
  "co.in", "org.in", "net.in", "ac.in", "gov.in", "res.in",
  "co.nz", "org.nz", "net.nz", "geek.nz", "maori.nz", "school.nz",
  "co.za", "org.za", "net.za", "gov.za", "school.za", "web.za",
  "co.th", "or.th", "ac.th", "go.th", "mi.th", "net.th",
  "co.id", "or.id", "ac.id", "go.id", "mil.id", "net.id",
  "co.ke", "or.ke", "ne.ke", "go.ke", "ac.ke", "sc.ke",
  "co.il", "org.il", "net.il", "ac.il", "gov.il", "muni.il",
  "co.cr", "or.cr", "ac.cr", "fi.cr", "go.cr", "sa.cr",
  "co.ve", "or.ve", "ac.ve", "gob.ve", "info.ve", "net.ve",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "csiro.au",
  "com.br", "net.br", "org.br", "gov.br", "edu.br", "g12.br",
  "com.mx", "net.mx", "org.mx", "gob.mx", "edu.mx",
  "com.ar", "net.ar", "org.ar", "gov.ar", "edu.ar",
  "com.sg", "net.sg", "org.sg", "gov.sg", "edu.sg", "per.sg",
  "com.my", "net.my", "org.my", "gov.my", "edu.my", "mil.my",
  "com.ph", "net.ph", "org.ph", "gov.ph", "edu.ph", "mil.ph",
  "com.vn", "net.vn", "org.vn", "gov.vn", "edu.vn", "int.vn",
  "com.tw", "net.tw", "org.tw", "gov.tw", "edu.tw", "idv.tw",
  "com.hk", "net.hk", "org.hk", "gov.hk", "edu.hk", "idv.hk",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "com.ua", "net.ua", "org.ua", "gov.ua", "edu.ua",
  "com.tr", "net.tr", "org.tr", "gov.tr", "edu.tr",
  "com.sa", "net.sa", "org.sa", "gov.sa", "edu.sa", "med.sa", "pub.sa",
  "com.eg", "net.eg", "org.eg", "gov.eg", "edu.eg", "sci.eg",
  "com.ng", "net.ng", "org.ng", "gov.ng", "edu.ng", "name.ng", "mil.ng",
  "com.pk", "net.pk", "org.pk", "gov.pk", "edu.pk", "fam.pk", "biz.pk", "web.pk",
  "com.bd", "net.bd", "org.bd", "gov.bd", "edu.bd", "mil.bd",
  "com.gh", "org.gh", "gov.gh", "edu.gh", "mil.gh",
  "co.tz", "or.tz", "ac.tz", "go.tz", "ne.tz",
  "co.ug", "or.ug", "ac.ug", "go.ug", "ne.ug", "sc.ug",
  "co.zw", "org.zw", "gov.zw", "ac.zw",
  "co.bw", "org.bw",
  "com.na", "org.na",
  "com.fj", "net.fj", "org.fj", "gov.fj", "mil.fj",
  "com.pa", "net.pa", "org.pa", "gob.pa", "edu.pa", "ing.pa", "sld.pa",
  "com.py", "net.py", "org.py", "gov.py", "edu.py", "mil.py", "coop.py",
  "com.bo", "net.bo", "org.bo", "gob.bo", "edu.bo", "tv.bo", "mil.bo", "int.bo",
  "com.ec", "net.ec", "org.ec", "gov.ec", "edu.ec", "mil.ec", "fin.ec", "med.ec", "info.ec",
  "com.gt", "net.gt", "org.gt", "gob.gt", "edu.gt", "mil.gt", "ind.gt",
  "com.hn", "net.hn", "org.hn", "gob.hn", "edu.hn", "mil.hn",
  "com.ni", "net.ni", "org.ni", "gob.ni", "edu.ni", "nom.ni", "mil.ni", "com.pa",
  "com.sv", "org.sv", "gob.sv", "edu.sv", "red.sv",
  "com.do", "net.do", "org.do", "gob.do", "edu.do", "sld.do", "web.do",
  "com.cu", "edu.cu", "org.cu", "inf.cu", "gov.cu", "com.pr", "net.pr", "org.pr", "gov.pr", "edu.pr",
  "gov.au", "id.au", "asn.au", "conf.au", "oz.au",
  "ac.at", "co.at", "gv.at", "or.at",
  "ac.be",
  "ac.ch",
  "ac.dk",
  "ac.fi",
  "ac.no", "co.no", "mil.no", "stat.no", "kommune.no", "fylkesbibl.no", "folkebibl.no", "museum.no",
  "ac.nz",
  "ac.th",
  "ac.za", "alt.za", "nis.za", "nom.za",
  "cc.in", "ernet.in", "res.in", "iisc.in", "iitm.in", "iitd.in", "iitk.in", "iitr.in", "iitb.in", "iitg.in", "iitkgp.in", "iitmandi.in", "iitj.ac.in", "iitp.ac.in", "iith.ac.in", "iitrpr.ac.in", "iittp.ac.in", "iitgn.ac.in", "iitjammu.ac.in", "iitdh.ac.in", "iitbbs.ac.in", "iitbhilai.ac.in", "iitdharwad.ac.in", "iitgoa.ac.in", "iitjammu.ac.in",
  "asso.fr", "com.fr", "gouv.fr", "nom.fr", "prd.fr", "tm.fr",
  "asso.nc",
  "gob.es", "nom.es",
  "ac.lk", "gov.lk", "net.lk", "org.lk", "edu.lk", "ngo.lk", "soc.lk", "web.lk", "ltd.lk", "assn.lk", "grp.lk", "hotel.lk",
  "ac.ru", "edu.ru", "gov.ru", "int.ru", "mil.ru", "net.ru", "org.ru", "pp.ru",
  "ac.se", "bd.se", "brand.se", "fh.se", "fhsk.se", "fhv.se", "for.se", "kom.se", "mil.se", "org.se", "parti.se", "pp.se", "press.se", "r.se", "s.se", "t.se", "tm.se", "u.se", "w.se", "x.se", "y.se", "z.se",
]);

/**
 * Extract root domain from a hostname using compound TLD awareness.
 * e.g. "blog.sub.example.co.uk" -> "example.co.uk"
 * e.g. "www.example.com" -> "example.com"
 * Falls back to last 2 parts for unknown TLDs.
 */
export function getRootDomain(hostname: string): string {
  const normalized = normalizeDomain(hostname, true);
  const parts = normalized.split(".");
  if (parts.length <= 2) return normalized;
  if (isIPv4(normalized)) return normalized;

  // Check for compound TLDs (e.g. "co.uk", "com.au")
  for (let i = parts.length - 2; i >= 0; i--) {
    const suffix = parts.slice(i).join(".");
    if (COMPOUND_TLDS.has(suffix)) {
      const rootStart = Math.max(0, i - 1);
      return parts.slice(rootStart).join(".");
    }
  }

  // Fallback: last 2 parts (covers most simple TLDs like .com, .org, .net)
  return parts.slice(-2).join(".");
}

/**
 * Normalize a domain: lowercase, strip www if requested, trim whitespace.
 */
export function normalizeDomain(domain: string, stripWww = true): string {
  let d = domain.trim().toLowerCase();
  if (d.startsWith("http://") || d.startsWith("https://")) {
    try {
      d = new URL(d).hostname;
    } catch {
      d = d.replace(/^https?:\/\//, "").split("/")[0] ?? d;
    }
  }
  d = (d.split("/")[0] ?? d).trim();
  d = (d.split("?")[0] ?? d).trim();
  d = (d.split("#")[0] ?? d).trim();
  // Strip port number (e.g. "example.com:8080" → "example.com")
  // Only strip if it's not an IPv6 address and the part after ":" is all digits.
  if (!d.startsWith("[")) {
    const colonIdx = d.lastIndexOf(":");
    if (colonIdx !== -1 && /^\d+$/.test(d.slice(colonIdx + 1))) {
      d = d.slice(0, colonIdx);
    }
  }
  if (stripWww && d.startsWith("www.")) {
    d = d.slice(4);
  }
  return d;
}

/**
 * Get domain hierarchy for block dialog choices.
 * Returns levels from most specific to least specific (excluding TLD-only).
 * e.g. "blog.sub.example.co.uk" -> ["blog.sub.example.co.uk", "sub.example.co.uk", "example.co.uk"]
 */
export function getDomainLevels(hostname: string): string[] {
  const normalized = normalizeDomain(hostname, true);
  const root = getRootDomain(normalized);
  const levels: string[] = [];

  // Walk from most specific to root
  let current = normalized;
  while (current.length >= root.length) {
    levels.push(current);
    if (current === root) break;
    const dotIdx = current.indexOf(".");
    if (dotIdx === -1) break;
    current = current.slice(dotIdx + 1);
  }

  return levels.filter((l, i, arr) => arr.indexOf(l) === i);
}

/**
 * Extract hostname from a URL string. Returns empty string on failure.
 */
export function getHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    const m = url.match(/^(?:https?|ftp):\/\/([^/?#]+)/i);
    if (!m?.[1]) return "";
    return m[1].split(":")[0]?.toLowerCase() ?? "";
  }
}

/**
 * Normalize to punycode-compatible ASCII for IDN domains.
 * Falls back to the input if encoding fails.
 */
export function toASCIIDomain(domain: string): string {
  try {
    const url = new URL("https://" + domain);
    return url.hostname;
  } catch {
    return domain;
  }
}

/**
 * Check if `candidate` matches `blocked` considering subdomain wildcard.
 * e.g. blocked = "example.com", candidate = "sub.example.com" -> true (with wildcard)
 */
export function domainMatches(
  candidate: string,
  blocked: string,
  subdomainWildcard: boolean
): boolean {
  const c = candidate.toLowerCase();
  const b = blocked.toLowerCase();
  if (c === b) return true;
  if (subdomainWildcard && c.endsWith("." + b)) return true;
  return false;
}

/**
 * Strip www. prefix from a domain (non-destructive for non-www domains).
 */
export function stripWww(domain: string): string {
  if (domain.startsWith("www.")) return domain.slice(4);
  return domain;
}

/** IPv4 check — avoid treating IP addresses as domains */
export function isIPv4(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
}
