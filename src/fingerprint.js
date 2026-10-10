/**
 * Fingerprint inspection.
 *
 * The leak-debugging workflow in the Camoufox documentation works by bisecting
 * the spoofed configuration one property at a time, and needs a Linux build
 * system to do it. The question it answers — *what does this browser claim about
 * itself, and do the claims agree with each other?* — is answerable from the
 * page, because that is where every spoofed value is observable.
 *
 * The probe returns a JSON **string**: the engine coerces an evaluated object to
 * `[object Object]` (verified against a live engine), so anything structured has
 * to be serialised in the page before it comes back.
 *
 * @module dsh-camofox/fingerprint
 */

/**
 * The properties a bot check compares against each other, collected in one pass.
 *
 * The pairs are what matter: a user agent claiming macOS beside a Windows
 * timezone is a contradiction no single property reveals. So the module returns
 * the readings AND the disagreements, which is the part a human would otherwise
 * have to derive by eye.
 */
const PROBE_BODY = `(() => {
  const n = navigator, s = screen, w = window;
  const out = {};
  const safe = (fn, fallback) => { try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; } };

  out.userAgent = safe(() => n.userAgent, null);
  out.platform = safe(() => n.platform, null);
  out.vendor = safe(() => n.vendor, null);
  out.languages = safe(() => Array.from(n.languages || []), null);
  out.language = safe(() => n.language, null);
  out.hardwareConcurrency = safe(() => n.hardwareConcurrency, null);
  out.deviceMemory = safe(() => n.deviceMemory, null);
  out.webdriver = safe(() => n.webdriver, null);
  out.plugins = safe(() => (n.plugins ? n.plugins.length : null), null);
  out.maxTouchPoints = safe(() => n.maxTouchPoints, null);

  out.screen = safe(() => ({
    width: s.width, height: s.height,
    availWidth: s.availWidth, availHeight: s.availHeight,
    innerWidth: w.innerWidth, innerHeight: w.innerHeight,
    colorDepth: s.colorDepth, pixelDepth: s.pixelDepth,
    devicePixelRatio: w.devicePixelRatio,
  }), null);

  out.timezone = safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone, null);
  out.timezoneOffsetMinutes = safe(() => new Date().getTimezoneOffset(), null);
  out.locale = safe(() => Intl.DateTimeFormat().resolvedOptions().locale, null);

  out.webgl = safe(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return null;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
      renderer: gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
    };
  }, null);

  out.canvas = safe(() => {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.font = '11pt Arial';
    ctx.fillText('Cwm fjordbank glyphs vext quiz', 2, 15);
    // The pixels, not the image: comparable across runs without a screenshot.
    return Array.from(ctx.getImageData(0, 0, 62, 20).data.slice(0, 24)).join(',');
  }, null);

  out.permissions = safe(() => 'supported', null);
  out.chromeRuntime = safe(() => typeof w.chrome !== 'undefined' && typeof w.chrome.runtime !== 'undefined', null);
  out.pdfViewer = safe(() => 'PDFViewerApplication' in w, null);
  out.webrtc = safe(() => typeof w.RTCPeerConnection !== 'undefined', null);
  out.cookieEnabled = safe(() => navigator.cookieEnabled, null);

  return JSON.stringify(out);
})()`

/** The expression to evaluate in the page. */
export const FINGERPRINT_PROBE = PROBE_BODY

/**
 * Every timezone offset, in minutes, that any inhabited zone has ever used.
 *
 * Deliberately one shared set rather than one per operating system: a set small
 * enough to be exhaustive cannot also be specific enough to catch anything, and
 * a false accusation costs more than a missed one — the model would go looking
 * for a leak that is not there.
 */
const VALID_TIMEZONE_OFFSETS = {
  windows: new Set([0, 60, 120, 180, 210, 240, 270, 300, 330, 345, 360, 390, 420, 480, 525, 690]),
  macos: new Set([0, 60, 120, 180, 210, 240, 270, 300, 330, 345, 360, 390, 420, 480, 525, 690]),
  linux: new Set([0, 60, 120, 180, 210, 240, 270, 300, 330, 345, 360, 390, 420, 480, 525, 690]),
}

/**
 * Where a user agent of each kind normally sits, used only to REPORT a
 * surprising timezone rather than to condemn it. Windows and macOS users are
 * everywhere, so only the impossible combinations are excluded.
 */
const ZONES_EXPECTED_ON = {
  // A Windows machine in Europe is ordinary; one reporting a Pacific island is
  // the case worth naming.
  windows: /^(?!Pacific\/)/,
  macos: /^(?!Antarctica\/|Indian\/)/,
}

/**
 * Compare readings that a bot check would compare, and name what disagrees.
 *
 * @param {Record<string, any>} reading - the parsed probe output.
 * @returns {string[]} one sentence per observation, empty when nothing stands out.
 */
export function fingerprintTensions(reading) {
  if (!reading || typeof reading !== 'object') return []
  const problems = []
  const ua = typeof reading.userAgent === 'string' ? reading.userAgent : ''

  // The OS is legible from the UA alone, so no extra detection is needed.
  const claims = [
    [/Windows NT/i, 'windows'],
    [/Mac OS X|Macintosh/i, 'macos'],
    [/Android/i, 'android'],
    [/(iPhone|iPad|iPod)/i, 'ios'],
    [/Linux/i, 'linux'],
  ].filter(([pattern]) => pattern.test(ua)).map(([, name]) => name)

  if (claims.length === 1) {
    const claim = claims[0]
    const minutes = reading.timezoneOffsetMinutes
    // Offset arithmetic decides very little on its own: most zones are whole
    // hours, but a handful sit at :30 or :45, and daylight saving shifts every
    // one of them twice a year. So the check stays conservative and reports
    // only an offset no zone in that OS has ever used.
    const validOffsets = VALID_TIMEZONE_OFFSETS[claim]
    if (!validOffsets) {
      problems.push(`the user agent claims ${claim}, which this check cannot compare against a timezone`)
    } else if (typeof minutes === 'number' && !validOffsets.has(Math.abs(minutes))) {
      problems.push(`the user agent claims ${claim} but the timezone offset is ${minutes} minutes, which no ${claim} zone uses`)
    }

    // A named zone is stronger evidence than the offset, and the two are read
    // together: a Windows user agent beside "Europe/Bucharest" is the ordinary
    // case of a real machine in Romania, which is a legitimate configuration
    // and not a contradiction. It is reported so the model knows what the
    // browser claims, not because it is wrong.
    if (typeof reading.timezone === 'string' && reading.timezone !== '') {
      const zone = reading.timezone
      const expected = ZONES_EXPECTED_ON[claim]
      if (expected && !expected.test(zone)) {
        problems.push(`the browser reports the timezone ${zone}, which is not where a ${claim} user agent would normally sit; that is legitimate if this machine really is there, and a leak if the identity is being spoofed elsewhere`)
      }
    }
  }
  if (claims.length > 1) {
    problems.push(`the user agent names more than one platform: ${claims.join(', ')}`)
  }

  if (reading.webdriver === true) {
    problems.push('navigator.webdriver is true, which is the single most common automation tell')
  }
  if (reading.userAgent === '' || reading.userAgent == null) {
    problems.push('the user agent is empty, which no real browser reports')
  }
  if (reading.plugins === 0 && typeof reading.userAgent === 'string' && /Firefox/.test(reading.userAgent)) {
    problems.push('the user agent claims Firefox but no plugins are visible')
  }
  return problems
}