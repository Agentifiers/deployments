import { Schema } from "effect";

function text(label: string, maximumCharacters: number) {
  return Schema.String.pipe(
    Schema.check(
      Schema.isTrimmed({ message: `${label} must not contain surrounding whitespace.` }),
      Schema.isMinLength(1, { message: `${label} must not be empty.` }),
      Schema.isMaxLength(maximumCharacters, {
        message: `${label} must not exceed ${maximumCharacters} characters.`,
      }),
    ),
  );
}

function matchingText(
  label: string,
  maximumCharacters: number,
  matches: (value: string) => boolean,
) {
  return text(label, maximumCharacters).pipe(
    Schema.check(
      Schema.makeFilter<string>((value) =>
        matches(value) ? undefined : `${label} has an invalid format.`,
      ),
    ),
  );
}

const ActionText = text("RCS action text", 25);
const PostbackData = text("RCS action postback data", 2_048);
const E164PhoneNumber = matchingText("RCS phone number", 16, (value) =>
  /^\+[1-9]\d{7,14}$/u.test(value),
);
const HttpsUrl = matchingText("RCS action URL", 2_048, (value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
});
const S3Uri = matchingText("RCS media URI", 2_000, (value) => /^s3:\/\/[^/]+\/.+/u.test(value));
function isRfc3339Timestamp(value: string) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (!match) return false;
  const year = Number(match[1]!);
  const month = Number(match[2]!);
  const day = Number(match[3]!);
  const hour = Number(match[4]!);
  const minute = Number(match[5]!);
  const second = Number(match[6]!);
  const offsetHour = Number(match[8] ?? "0");
  const offsetMinute = Number(match[9] ?? "0");
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1]! &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

const IsoTimestamp = matchingText("RCS calendar timestamp", 64, isRfc3339Timestamp);

const ReplyAction = Schema.Struct({
  PostbackData,
  Text: ActionText,
});
const DialPhoneAction = Schema.Struct({
  PhoneNumber: E164PhoneNumber,
  PostbackData,
  Text: ActionText,
});
const ShowLocationAction = Schema.Struct({
  Label: Schema.optional(text("RCS location label", 100)),
  Latitude: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: -90, maximum: 90 }))),
  Longitude: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: -180, maximum: 180 }))),
  PostbackData,
  Text: ActionText,
});
const RequestLocationAction = Schema.Struct({ PostbackData, Text: ActionText });
const CreateCalendarEventAction = Schema.Struct({
  Description: Schema.optional(text("RCS calendar description", 500)),
  EndTime: IsoTimestamp,
  PostbackData,
  StartTime: IsoTimestamp,
  Text: ActionText,
  Title: text("RCS calendar title", 100),
});
const OpenUrlAction = Schema.Union([
  Schema.Struct({ PostbackData, Text: ActionText, Url: HttpsUrl }),
  Schema.Struct({
    Application: Schema.Literal("BROWSER"),
    PostbackData,
    Text: ActionText,
    Url: HttpsUrl,
  }),
  Schema.Struct({
    Application: Schema.Literal("WEBVIEW"),
    PostbackData,
    Text: ActionText,
    Url: HttpsUrl,
    WebviewViewMode: Schema.optional(Schema.Literals(["FULL", "HALF", "TALL"])),
  }),
]);

export const AwsRcsSuggestedAction = Schema.Union([
  Schema.Struct({ Reply: ReplyAction }),
  Schema.Struct({ OpenUrl: OpenUrlAction }),
  Schema.Struct({ DialPhone: DialPhoneAction }),
  Schema.Struct({ ShowLocation: ShowLocationAction }),
  Schema.Struct({ RequestLocation: RequestLocationAction }),
  Schema.Struct({ CreateCalendarEvent: CreateCalendarEventAction }),
]);

const CardSuggestions = Schema.Array(AwsRcsSuggestedAction).pipe(
  Schema.check(Schema.isMaxLength(4)),
);
const CardMedia = Schema.Struct({
  FileUrl: S3Uri,
  Height: Schema.optional(Schema.Literals(["SHORT", "MEDIUM", "TALL"])),
  ThumbnailUrl: Schema.optional(S3Uri),
});
const CarouselCardMedia = Schema.Struct({
  FileUrl: S3Uri,
  Height: Schema.optional(Schema.Literals(["SHORT", "MEDIUM"])),
  ThumbnailUrl: Schema.optional(S3Uri),
});
const CardContent = Schema.Struct({
  Description: Schema.optional(text("RCS card description", 2_000)),
  Media: Schema.optional(CardMedia),
  Suggestions: Schema.optional(CardSuggestions),
  Title: Schema.optional(text("RCS card title", 200)),
});
const CarouselCardContent = Schema.Struct({
  Description: Schema.optional(text("RCS carousel card description", 2_000)),
  Media: Schema.optional(CarouselCardMedia),
  Suggestions: Schema.optional(CardSuggestions),
  Title: Schema.optional(text("RCS carousel card title", 200)),
});
const StandaloneCard = Schema.Union([
  Schema.Struct({
    CardContent,
    CardOrientation: Schema.Literal("VERTICAL"),
  }),
  Schema.Struct({
    CardContent,
    CardOrientation: Schema.Literal("HORIZONTAL"),
    ThumbnailImageAlignment: Schema.optional(Schema.Literals(["LEFT", "RIGHT"])),
  }),
]);
const Carousel = Schema.Struct({
  CardContents: Schema.Array(CarouselCardContent).pipe(
    Schema.check(Schema.isMinLength(2), Schema.isMaxLength(10)),
  ),
  CardWidth: Schema.Literals(["SMALL", "MEDIUM"]),
});

export const AwsRcsMessageContent = Schema.Struct({
  Content: Schema.Union([
    Schema.Struct({ TextMessage: Schema.Struct({ Body: text("RCS text body", 3_072) }) }),
    Schema.Struct({
      FileMessage: Schema.Struct({
        FileUrl: S3Uri,
        ThumbnailUrl: Schema.optional(S3Uri),
      }),
    }),
    Schema.Struct({ RichCard: StandaloneCard }),
    Schema.Struct({ Carousel }),
  ]),
  Suggestions: Schema.optional(
    Schema.Array(AwsRcsSuggestedAction).pipe(Schema.check(Schema.isMaxLength(11))),
  ),
});

const FallbackMessageBody = text("RCS fallback message", 1_600);
const FallbackMediaUrls = Schema.Array(S3Uri).pipe(Schema.check(Schema.isMaxLength(10)));
const FallbackConfiguration = Schema.Union([
  Schema.Struct({ Channel: Schema.Literal("SMS"), MessageBody: FallbackMessageBody }),
  Schema.Struct({
    Channel: Schema.Literal("MMS"),
    MediaUrls: Schema.optional(FallbackMediaUrls),
    MessageBody: FallbackMessageBody,
  }),
  Schema.Struct({
    Channel: Schema.Literal("MMS"),
    MediaUrls: FallbackMediaUrls.pipe(Schema.check(Schema.isMinLength(1))),
    MessageBody: Schema.optional(FallbackMessageBody),
  }),
]);
const TimeToLive = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "RCS time to live must be an integer." }),
    Schema.isBetween({ minimum: 1, maximum: 172_800 }, { message: "RCS time to live is invalid." }),
  ),
);

export const AwsRcsMessage = Schema.Struct({
  ConfigurationSetName: Schema.optional(text("RCS configuration set", 512)),
  Context: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  DryRun: Schema.optional(Schema.Boolean),
  FallbackConfiguration: Schema.optional(FallbackConfiguration),
  MaxPrice: Schema.optional(text("RCS maximum price", 64)),
  MessageFeedbackEnabled: Schema.optional(Schema.Boolean),
  MessageTrafficType: Schema.optional(
    Schema.Literals([
      "ACKNOWLEDGEMENT",
      "AUTHENTICATION",
      "PROMOTION",
      "SERVICE_REQUEST",
      "TRANSACTION",
    ]),
  ),
  ProtectConfigurationId: Schema.optional(text("RCS protect configuration", 512)),
  RcsMessageContent: Schema.optional(AwsRcsMessageContent),
  TimeToLive: Schema.optional(TimeToLive),
});

export function decodeAwsRcsMessage(value: unknown) {
  try {
    return Schema.decodeUnknownSync(AwsRcsMessage, { onExcessProperty: "error" })(value);
  } catch (cause) {
    throw new TypeError("RCS message options do not match the AWS RCS contract.", { cause });
  }
}
