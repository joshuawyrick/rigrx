/* ============ RIGRX chat guard ============
   Shared by the browser and the server so both sides judge a message the same way.
   The browser uses it to prompt before a message is sent; the server uses it to
   record a flag after the fact, because a determined provider can bypass the
   browser but never the server.

   Design rules:
   - This NEVER blocks a message. A driver on the shoulder at 2am who can't get
     help through is a worse failure than any leak.
   - Aimed at low false positives. A prompt the driver sees on every other message
     is a prompt he learns to dismiss without reading.
*/
(function (root) {

  // --- a driver handing over his exact spot -------------------------------
  const SHARE = [
    // 35.3733, -119.0187
    { kind: 'coords',   re: /-?\d{1,3}\.\d{3,}\s*[, ]\s*-?\d{1,3}\.\d{3,}/ },
    // a map link of any flavour
    { kind: 'maplink',  re: /(google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps|maps\.apple\.com|what3words|w3w\.co|\/\/maps\.)/i },
    // mile marker 253 · MM253 · milepost 12
    { kind: 'milemarker', re: /\b(mile\s*marker|mile\s*post|milepost|marker|mm|mp)\s*#?\s*\d{1,3}\b/i },
    // exit 257
    { kind: 'exit',     re: /\bexit\s*#?\s*\d{1,3}\b/i },
    // 4200 Rosedale Hwy · 1201 N Chester Ave
    { kind: 'address',  re: /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*)?\s+(st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|hwy|highway|way|pkwy|parkway|ct|court|pl|place|cir|circle)\b\.?/i },
    // "cross streets are…" / "corner of Union and Brundage"
    { kind: 'cross',    re: /\b(cross\s*streets?|corner\s+of)\b/i },
    // "dropping a pin" / "sending my location"
    { kind: 'pin',      re: /\b(drop(?:ping|ped)?\s+(?:a\s+|you\s+a\s+|my\s+)?pin|send(?:ing)?\s+(?:you\s+)?(?:my\s+)?location|here'?s\s+my\s+location|my\s+location\s+is)\b/i }
  ];

  // --- a company fishing for it before they've been chosen ----------------
  const ASK = [
    { kind: 'ask_where',   re: /\bwhere\s+(are|r)\s+(you|u|ya)\b|\bwhere\s+(you|u)\s+at\b|\bwhereabouts\b/i },
    // "what's your 20" is how this actually gets asked on a CB
    { kind: 'ask_twenty',  re: /\b(what'?s|whats)\s+(your|ur|yer)\s+(20|twenty)\b|\byour\s+20\b/i },
    { kind: 'ask_exact',   re: /\b(exact|precise|specific)\s+(location|spot|position|address|coordinates)\b/i },
    { kind: 'ask_send',    re: /\b(send|share|text|give|shoot)\s+(me\s+)?(your|ur|the)\s+(location|address|pin|gps|coordinates|spot|position)\b/i },
    { kind: 'ask_pin',     re: /\bdrop\s+(me\s+)?(a\s+)?pin\b/i },
    { kind: 'ask_marker',  re: /\b(what|which|whats|what'?s)\s+(mile\s*marker|milepost|exit|cross\s*street|address)\b/i },
    { kind: 'ask_address', re: /\b(your|ur)\s+(exact\s+)?address\b/i }
  ];

  // --- taking the conversation off RIGRX ----------------------------------
  // Buyers already have the driver's number, so this isn't blocked or warned on —
  // it is logged so the admin can see which companies work around the platform.
  const OFFPLATFORM = [
    { kind: 'offplatform', re: /\b(call|text)\s+me\s+(at|on)?\s*(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/i },
    { kind: 'offplatform', re: /\b(give\s+me\s+a\s+(call|ring)|call\s+my\s+cell|hit\s+me\s+up\s+at|reach\s+me\s+at)\b/i },
    { kind: 'offplatform', re: /\b(whats?app|telegram|signal|facebook\s+messenger)\b/i }
  ];

  function firstMatch(text, list) {
    const t = String(text || '');
    for (const p of list) {
      const m = t.match(p.re);
      if (m) return { kind: p.kind, snippet: String(m[0]).slice(0, 80) };
    }
    return null;
  }

  /* What, if anything, is worth acting on in this message?
     role: 'driver' | 'provider'.  Returns null or { type, kind, snippet }.
       type 'share'       — the driver is handing over his exact spot early
       type 'ask'         — the company is fishing for it before being chosen
       type 'offplatform' — someone is moving the job off RIGRX          */
  function inspect(text, role) {
    if (!text) return null;
    if (role === 'driver') {
      const hit = firstMatch(text, SHARE);
      if (hit) return { type: 'share', kind: hit.kind, snippet: hit.snippet };
    } else {
      const hit = firstMatch(text, ASK);
      if (hit) return { type: 'ask', kind: hit.kind, snippet: hit.snippet };
    }
    const off = firstMatch(text, OFFPLATFORM);
    if (off) return { type: 'offplatform', kind: off.kind, snippet: off.snippet };
    return null;
  }

  const api = { inspect, SHARE, ASK, OFFPLATFORM };
  root.RIGRX_GUARD = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
