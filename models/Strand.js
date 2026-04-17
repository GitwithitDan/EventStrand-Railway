const mongoose = require('mongoose');

const ruleSchema = new mongoose.Schema({
  pattern:    { type: String, enum: ['daily','weekly','monthly_week','monthly_date','annual'], default: 'weekly' },
  every:      { type: Number, default: 1 },
  days:       [String],
  time_start: String,
  time_end:   String,
  month_week: String,
  month_date: Number,
  season_start: String,
  season_end:   String,
}, { _id: false });

const exceptionSchema = new mongoose.Schema({
  type:       { type: String, enum: ['skip','cancelled_range','modified'] },
  date:       String,
  date_end:   String,
  note:       String,
  time_start: String,
}, { _id: false });

const dateEntrySchema = new mongoose.Schema({
  date:       String,
  time_start: String,
  time_end:   String,
  note:       String,
}, { _id: false });

const eventSchema = new mongoose.Schema({
  title:        String,
  category:     String,
  vibes:        [String],
  price:        { type: String, default: 'free' },
  price_note:   String,
  ticket_url:   String,
  lead_time_days: { type: Number, default: 0 },
  notes:        String,
  // schedule type: recurring | oneoff | datelist
  event_type:   { type: String, default: 'recurring' },
  // oneoff
  date:         String,
  time_start:   String,
  time_end:     String,
  // datelist
  date_list:    [dateEntrySchema],
  // recurring
  recurrence:   [ruleSchema],
  exceptions:   [exceptionSchema],
  // engagement
  views:        { type: Number, default: 0 },
}, { _id: true });

const strandSchema = new mongoose.Schema({
  publisher:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  publisherHandle:  String,
  title:            { type: String, required: true },
  description:      String,
  type:             String,
  venue:            String,
  address:          String,
  city:             String,
  timezone:         String,
  color:            { type: String, default: '#6C8FFF' },
  website:          String,
  visibility:       { type: String, enum: ['public','unlisted','protected'], default: 'public' },
  accessCode:       String,
  published:        { type: Boolean, default: false },
  events:           [eventSchema],
  // analytics
  viewCount:        { type: Number, default: 0 },
  scanCount:        { type: Number, default: 0 },
  subscriberCount:  { type: Number, default: 0 },
  viewsHistory:     { type: [Number], default: () => new Array(30).fill(0) }, // rolling 30-day
  scanOrigins:      [{ label: String, count: Number }],
  lastViewedAt:     Date,
}, { timestamps: true });

strandSchema.index({ publisher: 1 });
strandSchema.index({ publisherHandle: 1 });
strandSchema.index({ visibility: 1, published: 1 });

module.exports = mongoose.model('Strand', strandSchema);
