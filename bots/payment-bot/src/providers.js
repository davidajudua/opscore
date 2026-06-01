/**
 * Per-provider configuration for IMAP monitoring + email parsing.
 *
 * Each provider has:
 *   id           short identifier ('zelle' | 'venmo' | 'paypal')
 *   label        display name
 *   senders      list of substrings; emails whose From contains any of these are eligible
 *   parse(msg)   parse a ParsedMessage, return { amount, name } or null if not a real payment
 *
 * The parse functions are intentionally permissive — payment-confirmation email formats
 * vary between banks (Zelle especially) and across years, so each parser tries multiple
 * patterns. They return null when the email doesn't look like an inbound payment so
 * outbound notifications, refunds, and disputes don't pollute the ledger.
 */

const AMOUNT = String.raw`\$\s*([\d,]+(?:\.\d{1,2})?)`;
// Each name word: capital letter followed by optional more chars — covers
// full names ("John Doe") AND Venmo-style last-initial ("Jordan T"). Allows
// up to 3 trailing words after the first.
const NAME = String.raw`([A-Z][A-Za-z'\-\.]*(?:\s+[A-Z][A-Za-z'\-\.]*){0,3})`;

function cleanText(s) {
  return s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

function toAmount(s) {
  if (!s) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const PROVIDERS = {
  zelle: {
    id: 'zelle',
    label: 'Zelle',
    addressEnvKey: 'GMAIL_ADDRESS_ZELLE',
    passwordEnvKey: 'GMAIL_APP_PASSWORD_ZELLE',
    senders: [
      'customerservice@ealerts.bankofamerica.com',
      'no.reply.alerts@chase.com',
      'do_not_reply@wellsfargo.com',
      'usbank@notifications.usbank.com',
      'ally@ally.com',
      'zellepay@zellepay.com',
    ],
    parse(msg) {
      const subject = cleanText(msg.subject ?? '');
      const body = cleanText(msg.text || (msg.html ? msg.html.replace(/<[^>]+>/g, ' ') : ''));
      const haystack = `${subject}\n${body}`;

      // US Bank-specific phrasing: "payment of $X from <Name> was deposited"
      const usbank = haystack.match(
        new RegExp(`payment of ${AMOUNT} from ${NAME}.*was deposited`, 'i'),
      );
      if (usbank) return { amount: toAmount(usbank[1]), name: cleanText(usbank[2]) };

      // Generic: "received from / money from / payment from / sent by <Name> ... $X"
      const generic = haystack.match(
        new RegExp(
          `(?:received from|money from|payment from|sent by)\\s+${NAME}[^$]*${AMOUNT}`,
          'i',
        ),
      );
      if (generic) return { amount: toAmount(generic[2]), name: cleanText(generic[1]) };

      // Fallback: "<Name> sent you $X via Zelle"
      const fallback = haystack.match(new RegExp(`${NAME}\\s+sent you\\s+${AMOUNT}`, 'i'));
      if (fallback) return { amount: toAmount(fallback[2]), name: cleanText(fallback[1]) };

      // Chase 2026 format: headline "<Name> sent you money" + later table row
      // "Amount  $X". Name and amount are in different DOM nodes so the legacy
      // patterns miss them. Match across arbitrary HTML/whitespace between.
      const chase = haystack.match(
        new RegExp(`${NAME}\\s+sent you money[\\s\\S]{0,500}?Amount\\s+${AMOUNT}`, 'i'),
      );
      if (chase) return { amount: toAmount(chase[2]), name: cleanText(chase[1]) };

      // US Bank 2026 format: the dollar amount is intentionally omitted from
      // the notification ("A Zelle® payment from <Name> was deposited into
      // your account."). amount=null signals "name only" to the receipt
      // pipeline — embed renders with $- and ledger skips the row.
      const usbankNoAmount = haystack.match(
        new RegExp(`A Zelle\\W*\\s*payment\\s+from\\s+${NAME}\\s+was\\s+deposited`, 'i'),
      );
      if (usbankNoAmount) return { amount: null, name: cleanText(usbankNoAmount[1]) };

      return null;
    },
  },

  venmo: {
    id: 'venmo',
    label: 'Venmo',
    addressEnvKey: 'GMAIL_ADDRESS_VENMO',
    passwordEnvKey: 'GMAIL_APP_PASSWORD_VENMO',
    senders: ['venmo@venmo.com'],
    parse(msg) {
      const subject = cleanText(msg.subject ?? '');
      const body = cleanText(msg.text || (msg.html ? msg.html.replace(/<[^>]+>/g, ' ') : ''));
      const haystack = `${subject}\n${body}`;

      // Skip outbound notifications.
      if (/(?:you paid|payment to|you sent|your payment)/i.test(haystack)) return null;

      const m = haystack.match(new RegExp(`${NAME}\\s+(?:paid you|sent you)\\s+${AMOUNT}`, 'i'));
      if (m) return { amount: toAmount(m[2]), name: cleanText(m[1]) };
      return null;
    },
  },

  paypal: {
    id: 'paypal',
    label: 'PayPal',
    addressEnvKey: 'GMAIL_ADDRESS_PAYPAL',
    passwordEnvKey: 'GMAIL_APP_PASSWORD_PAYPAL',
    senders: ['service@paypal.com', 'service@intl.paypal.com'],
    parse(msg) {
      const subject = cleanText(msg.subject ?? '');
      const body = cleanText(msg.text || (msg.html ? msg.html.replace(/<[^>]+>/g, ' ') : ''));
      const haystack = `${subject}\n${body}`;

      // Skip non-payment events. Includes reversal/unauthorized notices, which use a
      // genuine inbound phrasing ("received $X from …") but must NOT be booked as income.
      // (Deliberately conservative: "pending"/"on hold" are NOT skipped here because they
      // also appear in legitimate completed-payment emails and would drop real income.)
      if (/(?:refund|dispute|failed|declined|cancelled|canceled|unauthorized|reversed|reversal)/i.test(haystack))
        return null;

      // Inbound subject patterns first. Pattern 2 tolerates "You've" (straight or curly
      // apostrophe) and an optional ISO currency code between amount and "from", e.g.
      // "You've received $18.00 USD from Jamie Rivera".
      const subjMatch =
        subject.match(new RegExp(`${NAME}\\s+sent you\\s+${AMOUNT}`, 'i')) ||
        subject.match(
          new RegExp(
            `you(?:['’]ve)?\\s+received\\s+${AMOUNT}(?:\\s+[A-Z]{3})?\\s+from\\s+${NAME}`,
            'i',
          ),
        ) ||
        subject.match(new RegExp(`received a payment of\\s+${AMOUNT}\\s+from\\s+${NAME}`, 'i'));
      if (subjMatch) {
        const [, a, b] = subjMatch;
        // Two formats above put name and amount in different orders. Detect by parseability.
        if (toAmount(a) !== null) return { amount: toAmount(a), name: cleanText(b) };
        return { amount: toAmount(b), name: cleanText(a) };
      }

      // Body fallback: require the verb to sit directly after the name (no slack between
      // name and verb). Cap name to 1–2 words; "Hello, <4-word recipient>" preheaders
      // would otherwise let NAME swallow part of the recipient + part of the sender.
      const SHORT_NAME = String.raw`([A-Z][A-Za-z'\-\.]+(?:\s+[A-Z][A-Za-z'\-\.]+)?)`;
      const bodyMatch = body.match(
        new RegExp(
          `${SHORT_NAME}\\s+(?:has\\s+)?(?:sent|paid)(?:\\s+(?:you|a\\s+payment(?:\\s+of)?))?.{0,40}?${AMOUNT}`,
          'i',
        ),
      );
      if (bodyMatch) return { amount: toAmount(bodyMatch[2]), name: cleanText(bodyMatch[1]) };

      return null;
    },
  },
};

export function activeProviders(env) {
  const out = [];
  for (const p of Object.values(PROVIDERS)) {
    if (env[p.addressEnvKey] && env[p.passwordEnvKey]) out.push(p);
  }
  return out;
}
