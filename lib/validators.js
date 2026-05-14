// ── PAYLOAD VALIDATORS ─────────────────────────────────────────
// zod schemas for POST/PUT request bodies. Caps lengths and array
// sizes to prevent unbounded payloads from creating huge documents.
//
// Limits chosen conservatively:
//   title:          120 chars   (room for venue + short tagline)
//   description:    2 KB        (a couple of paragraphs)
//   notes/text:     1 KB        (per-event notes)
//   events array:   100 items   (per strand)
//   date_list:      200 entries (per event — covers ~4 yrs of weekly dates)
//   recurrence/exc: 20 each     (per event)
const { z } = require('zod');

const SHORT  = 120;
const URL_   = 500;
const TEXT   = 2000;
const NOTE   = 1000;

const ruleSchema = z.object({
  pattern:      z.enum(['daily','weekly','monthly_week','monthly_date','annual']).optional(),
  every:        z.number().int().min(1).max(365).optional(),
  days:         z.array(z.string().max(4)).max(7).optional(),
  time_start:   z.string().max(8).optional(),
  time_end:     z.string().max(8).optional(),
  month_week:   z.string().max(10).optional(),
  month_date:   z.number().int().min(1).max(31).optional(),
  season_start: z.string().max(4).optional(),
  season_end:   z.string().max(4).optional(),
}).passthrough();

const exceptionSchema = z.object({
  type:       z.enum(['skip','cancelled_range','modified']),
  date:       z.string().max(10),
  date_end:   z.string().max(10).optional(),
  note:       z.string().max(NOTE).optional(),
  time_start: z.string().max(8).optional(),
}).passthrough();

const dateEntrySchema = z.object({
  date:       z.string().max(10),
  time_start: z.string().max(8).optional(),
  time_end:   z.string().max(8).optional(),
  note:       z.string().max(NOTE).optional(),
}).passthrough();

const eventSchema = z.object({
  _id:            z.string().optional(),
  title:          z.string().max(SHORT).optional(),
  category:       z.string().max(SHORT).optional(),
  vibes:          z.array(z.string().max(40)).max(20).optional(),
  price:          z.string().max(40).optional(),
  price_note:     z.string().max(NOTE).optional(),
  ticket_url:     z.string().max(URL_).optional(),
  lead_time_days: z.number().int().min(0).max(3650).optional(),
  notes:          z.string().max(NOTE).optional(),
  event_type:     z.string().max(20).optional(),
  date:           z.string().max(10).optional(),
  time_start:     z.string().max(8).optional(),
  time_end:       z.string().max(8).optional(),
  date_list:      z.array(dateEntrySchema).max(200).optional(),
  recurrence:     z.array(ruleSchema).max(20).optional(),
  exceptions:     z.array(exceptionSchema).max(50).optional(),
}).passthrough();

const metaSchema = z.object({
  title:        z.string().min(1, 'Title required').max(SHORT),
  description:  z.string().max(TEXT).optional(),
  type:         z.string().max(SHORT).optional(),
  location:     z.string().max(TEXT).optional(),
  timezone:     z.string().max(64).optional(),
  color:        z.string().max(20).optional(),
  website:      z.string().max(URL_).optional(),
  visibility:   z.enum(['public','unlisted','protected']).optional(),
  access_code:  z.string().max(60).optional(),
}).passthrough();

const strandCreateSchema = z.object({
  rcal:        z.string().max(20).optional(),
  meta:        metaSchema,
  events:      z.array(eventSchema).max(100).optional(),
  visibility:  z.enum(['public','unlisted','protected']).optional(),
  accessCode:  z.string().max(60).optional(),
}).passthrough();

const strandUpdateSchema = z.object({
  meta:        metaSchema.partial().optional(),
  events:      z.array(eventSchema).max(100).optional(),
  visibility:  z.enum(['public','unlisted','protected']).optional(),
  accessCode:  z.string().max(60).optional(),
}).passthrough();

const braidCreateSchema = z.object({
  title:        z.string().min(1, 'Title required').max(SHORT),
  description:  z.string().max(TEXT).optional(),
  strandIds:    z.array(z.string().max(40)).max(100).optional(),
  visibility:   z.enum(['public','unlisted','protected']).optional(),
  accessCode:   z.string().max(60).optional(),
}).passthrough();

const braidUpdateSchema = z.object({
  title:        z.string().max(SHORT).optional(),
  description:  z.string().max(TEXT).optional(),
  strandIds:    z.array(z.string().max(40)).max(100).optional(),
  visibility:   z.enum(['public','unlisted','protected']).optional(),
  accessCode:   z.string().max(60).optional(),
}).passthrough();

// Auth schemas
const registerSchema = z.object({
  email:        z.string().email().max(254),
  password:     z.string().min(8).max(200),
  displayName:  z.string().max(60).optional(),
  accountType:  z.enum(['personal','venue']).optional(),
}).passthrough();

const loginSchema = z.object({
  email:    z.string().email().max(254),
  password: z.string().min(1).max(200),
}).passthrough();

const forgotPasswordSchema = z.object({
  email: z.string().email().max(254),
}).passthrough();

const resetPasswordSchema = z.object({
  token:    z.string().min(20).max(200),
  password: z.string().min(8).max(200),
}).passthrough();

const verifyEmailSchema = z.object({
  token: z.string().min(20).max(200),
}).passthrough();

// ── MIDDLEWARE FACTORY ───────────────────────────────────────
// Wrap a zod schema as Express middleware. Replaces req.body with
// the parsed (and stripped, if .strict) version on success, or
// returns 400 with the first error message on failure.
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const first = result.error.issues[0];
      const path = first.path.join('.') || 'body';
      return res.status(400).json({ error: `${path}: ${first.message}` });
    }
    req.body = result.data;
    next();
  };
}

module.exports = {
  validate,
  schemas: {
    strandCreate:    strandCreateSchema,
    strandUpdate:    strandUpdateSchema,
    braidCreate:     braidCreateSchema,
    braidUpdate:     braidUpdateSchema,
    register:        registerSchema,
    login:           loginSchema,
    forgotPassword:  forgotPasswordSchema,
    resetPassword:   resetPasswordSchema,
    verifyEmail:     verifyEmailSchema,
  },
};
