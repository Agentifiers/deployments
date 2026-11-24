import { describe, expect, it } from "bun:test";
import {
  buildMemoryFlushPrompt,
  inspectMemoryContent,
  memoryFlushOutputTokenLimit,
  MEMORY_CHECKPOINT_MAX_BYTES,
  MEMORY_FLUSH_MAX_OUTPUT_TOKENS,
  MEMORY_FLUSH_MAX_TRANSCRIPT_CHARS,
  memoryMetadataBlockedReason,
  parseMemoryFlushCandidates,
  parseMemoryFlushCompletion,
  parseMemoryFlushResult,
  sanitizeMemoryConversationContent,
  selectMemoryFlushMessageBatch,
  shouldRunMemoryFlush,
  validateMemorySearchKey,
} from "./governance.ts";
describe("memory governance", () => {
  it("bounds flush output independently from the checkpoint byte limit", () => {
    expect(MEMORY_FLUSH_MAX_OUTPUT_TOKENS).toBe(4_096);
    expect(MEMORY_CHECKPOINT_MAX_BYTES).toBe(8_192);
    expect(memoryFlushOutputTokenLimit(256)).toBe(256);
    expect(memoryFlushOutputTokenLimit(4_096)).toBe(4_096);
    expect(memoryFlushOutputTokenLimit(32_768)).toBe(MEMORY_FLUSH_MAX_OUTPUT_TOKENS);
  });

  it("rejects secret-like content before storage", () => {
    expect(inspectMemoryContent("api_key = sk-example-secret-value-123456")).toMatchObject({
      blockedReason: "Memory content contains secret-like material.",
      reviewStatus: "pending",
      sensitivity: "restricted",
    });
  });

  it("rejects credentials in serialized objects", () => {
    expect(inspectMemoryContent('{"password":"super-secret-production-value"}')).toMatchObject({
      blockedReason: "Memory content contains secret-like material.",
      sensitivity: "restricted",
    });
    for (const key of [
      "access_token",
      "aws_secret_access_key",
      "client_secret",
      "refresh_token",
      "secret_key",
    ]) {
      expect(
        inspectMemoryContent(JSON.stringify({ [key]: "credential-value-123456" })),
      ).toMatchObject({
        blockedReason: "Memory content contains secret-like material.",
      });
    }
  });

  it("rejects credentials in environment and shell assignments", () => {
    for (const content of [
      "AWS_SECRET_ACCESS_KEY=credential-value-123456",
      "DB_PASSWORD=credential-value-123456",
      "export CLIENT_SECRET='credential-value-123456'",
      'REFRESH_TOKEN="credential-value-123456"',
    ]) {
      expect(inspectMemoryContent(content)).toMatchObject({
        blockedReason: "Memory content contains secret-like material.",
        sensitivity: "restricted",
      });
    }
    expect(inspectMemoryContent('{"database_password":"credential-value-123456"}')).toMatchObject({
      blockedReason: "Memory content contains secret-like material.",
    });
    for (const content of [
      "The database password is super-secret-production-value.",
      "AWS secret access key is credential-value-123456.",
    ]) {
      expect(inspectMemoryContent(content)).toMatchObject({
        blockedReason: "Memory content contains secret-like material.",
      });
    }
  });

  it("rejects credentials nested in memory metadata", () => {
    expect(
      memoryMetadataBlockedReason({ integration: { client_secret: "credential-value" } }),
    ).toBe("Memory metadata contains secret-like material.");
    expect(memoryMetadataBlockedReason({ note: "Bearer abcdefghijklmnopqrstuvwxyz123456" })).toBe(
      "Memory metadata contains secret-like material.",
    );
    expect(memoryMetadataBlockedReason({ "sk-example-secret-value-123456": true })).toBe(
      "Memory metadata contains secret-like material.",
    );
    expect(memoryMetadataBlockedReason({ category: "deployment" })).toBeUndefined();
    expect(memoryMetadataBlockedReason({ owner: "owner@example.com" })).toBe(
      "Memory metadata contains personal or health data.",
    );
    expect(memoryMetadataBlockedReason({ "owner@example.com": "primary" })).toBe(
      "Memory metadata contains personal or health data.",
    );
  });

  it("rejects common provider token formats", () => {
    for (const content of [
      "github_pat_1234567890abcdefghijklmnopqrstuv",
      "ghp_1234567890abcdefghijklmnop",
      "xapp-1-A1234567890-1234567890-abcdefghijklmnopqrstuv",
    ]) {
      expect(inspectMemoryContent(content)).toMatchObject({
        blockedReason: "Memory content contains secret-like material.",
        sensitivity: "restricted",
      });
    }
  });

  it("redacts personal data and requires review", () => {
    expect(inspectMemoryContent("Call Ava at 602-555-0110 about the release.")).toEqual({
      content: "Call Ava at [redacted phone] about the release.",
      redacted: true,
      reviewReason: "Potential personal data was redacted and requires review before recall.",
      reviewStatus: "pending",
      sensitivity: "restricted",
    });
  });

  it("does not read digit runs inside UUIDs or hex ids as phone numbers", () => {
    for (const content of [
      "Correlate run 99e4abd9-338a-41e8-ae11-7877651721a7 with the release.",
      "Shipped commit 72cc81b4878546346b67a7e6fe822a847723390d to staging.",
    ]) {
      expect(inspectMemoryContent(content)).toEqual({
        content,
        redacted: false,
        reviewStatus: "approved",
        sensitivity: "internal",
      });
    }
    expect(
      [
        "Page +1 (602) 555-0110 for run 99e4abd9-338a-41e8-ae11-7877651721a7.",
        "{6025550110-1234-1234-1234-123456789012}",
        "Call 602-555-0110x204.",
        "tel-602-555-0110",
        "Ava_602-555-0110",
        "電話は6025550110です",
      ].map((content) => inspectMemoryContent(content).content),
    ).toEqual([
      "Page [redacted phone] for run 99e4abd9-338a-41e8-ae11-7877651721a7.",
      "{[redacted phone]-1234-1234-1234-123456789012}",
      "Call [redacted phone]x204.",
      "tel-[redacted phone]",
      "Ava_[redacted phone]",
      "電話は[redacted phone]です",
    ]);
  });

  it("requires review for street addresses, birth dates, and broader health data", () => {
    for (const content of [
      "Ship the package to 123 Main Street Apt 4B.",
      "Ava's date of birth is January 2, 1990.",
      "The customer disclosed an asthma condition.",
    ]) {
      expect(inspectMemoryContent(content)).toMatchObject({
        reviewStatus: "pending",
        sensitivity: "restricted",
      });
      expect(sanitizeMemoryConversationContent(content)).toBe("[omitted sensitive content]");
    }
  });

  it("redacts street addresses, including streets named for a unit", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["Ship the package to 123 Main Street Apt 4B.", "Ship the package to [redacted address]."],
      ["Mail it to 1600 Pennsylvania Avenue NW.", "Mail it to [redacted address] NW."],
      ["She lives at 10 Downing St.", "She lives at [redacted address]."],
      ["Meet at 350 Fifth Ave.", "Meet at [redacted address]."],
      ["Deliver to 100 A St NE.", "Deliver to [redacted address] NE."],
      ["he lives at 42 old mill rd", "he lives at [redacted address]"],
      ["Office is 500 W Martin Luther King Jr Blvd Suite 200.", "Office is [redacted address]."],
      ["She lives at 412 Second Street.", "She lives at [redacted address]."],
      ["Office: 1 Second Ave Apt 4", "Office: [redacted address]"],
      [
        "The pier office is 200 Second Ave S, St. Petersburg.",
        "The pier office is [redacted address] S, St. Petersburg.",
      ],
      ["We moved to 9 Mile Rd last spring.", "We moved to [redacted address] last spring."],
      ["Mail it to 77 Seconds Rd.", "Mail it to [redacted address]."],
      ["Send it to 233 S Wacker Dr, Chicago.", "Send it to [redacted address], Chicago."],
      [
        "HQ is 1600 Amphitheatre Parkway, Mountain View.",
        "HQ is [redacted address], Mountain View.",
      ],
      [
        "The exchange is at 11 Wall Street, New York.",
        "The exchange is at [redacted address], New York.",
      ],
      ["Campus is 1 Microsoft Way, Redmond.", "Campus is [redacted address], Redmond."],
      ["The Met is at 1000 5th Ave, New York.", "The Met is at [redacted address], New York."],
      ["SFMOMA is 151 3rd St, San Francisco.", "SFMOMA is [redacted address], San Francisco."],
      ["The store is 20000 W 8 Mile Rd, Detroit.", "The store is [redacted address], Detroit."],
      [
        "CHOP is 3400 Civic Center Blvd, Philadelphia.",
        "CHOP is [redacted address], Philadelphia.",
      ],
      [
        "The Court sits at 1 First Street NE, Washington.",
        "The Court sits at [redacted address] NE, Washington.",
      ],
      ["Ship to 4500 E 10 Mile Road Suite 300.", "Ship to [redacted address]."],
      [
        "Our flat is 88 Second St Unit 12, San Francisco.",
        "Our flat is [redacted address], San Francisco.",
      ],
      ["The clinic is at 600 N 2nd St # 5B.", "The clinic is at [redacted address]."],
      ["we moved to 12 maple drive last year", "we moved to [redacted address] last year"],
      ["Drop it at 7 Mile High Way.", "Drop it at [redacted address]."],
      [
        "Text me at 31 Seven Seconds Ln when you arrive.",
        "Text me at [redacted address] when you arrive.",
      ],
      [
        "Send it to 1185 Avenue of the Americas, New York.",
        "Send it to [redacted address] of the Americas, New York.",
      ],
      [
        "My sister lives at 120 Day Street, San Francisco.",
        "My sister lives at [redacted address], San Francisco.",
      ],
      [
        "I moved to 500 Elm Street more than a year ago.",
        "I moved to [redacted address] more than a year ago.",
      ],
      ["She lives at 412 Oak St too.", "She lives at [redacted address] too."],
      [
        "The office is 1 Infinite Loop Way, Cupertino.",
        "The office is [redacted address], Cupertino.",
      ],
      ["Ship it to 2211 N First St, San Jose.", "Ship it to [redacted address], San Jose."],
      [
        "He lives at 77 Massachusetts Ave, Cambridge.",
        "He lives at [redacted address], Cambridge.",
      ],
      ["Mail to 4059 Mt Lee Dr, Hollywood.", "Mail to [redacted address], Hollywood."],
      ["Our house is 8 Times Square Rd.", "Our house is [redacted address]."],
      ["Visit us at 1 Hour Glass Ln.", "Visit us at [redacted address]."],
      ["Pick me up at 25 Steps Rd.", "Pick me up at [redacted address]."],
      ["We live at 300 Week St in town.", "We live at [redacted address] in town."],
      ["Deliver to 14 Block Island Rd.", "Deliver to [redacted address]."],
      ["Find us at 742 Evergreen Terrace Way.", "Find us at [redacted address]."],
      [
        "Return to 600 Montgomery St, San Francisco.",
        "Return to [redacted address], San Francisco.",
      ],
      ["Our office is 1 Hacker Way, Menlo Park.", "Our office is [redacted address], Menlo Park."],
      ["Send it to 405 Lexington Ave, New York.", "Send it to [redacted address], New York."],
      ["The hotel is 3570 Las Vegas Blvd S.", "The hotel is [redacted address] S."],
      ["We met at 101 Second St, San Francisco.", "We met at [redacted address], San Francisco."],
      ["The plant is at 12 Mile Rd, Warren.", "The plant is at [redacted address], Warren."],
      [
        "The bakery is at 31 Week Street, Maidstone.",
        "The bakery is at [redacted address], Maidstone.",
      ],
      ["He lives at 20 Day St, Somerville.", "He lives at [redacted address], Somerville."],
      ["Ship to 401 N Michigan Ave, Chicago.", "Ship to [redacted address], Chicago."],
      [
        "Our office is at 80 Feet Road, Koramangala.",
        "Our office is at [redacted address], Koramangala.",
      ],
      [
        "The tour starts at 17 Mile Drive, Pebble Beach.",
        "The tour starts at [redacted address], Pebble Beach.",
      ],
      [
        "The office moved to 1355 Market St Suite 900, San Francisco.",
        "The office moved to [redacted address], San Francisco.",
      ],
      [
        "The school is at 75 Second Ave, New York.",
        "The school is at [redacted address], New York.",
      ],
      ["My dentist is at 220 W Seventh St.", "My dentist is at [redacted address]."],
      ["He works from an 80 Broad St office.", "He works from an [redacted address] office."],
      [
        "I rented a 10 Downing St office for the shoot.",
        "I rented a [redacted address] office for the shoot.",
      ],
      ["we live at 500 elm street now", "we live at [redacted address] now"],
      ["The campus is 327 Mile End Road, London.", "The campus is [redacted address], London."],
      ["The ballpark is 501 Crawford St, Houston.", "The ballpark is [redacted address], Houston."],
      ["Ship to 1 Yawkey Way, Boston.", "Ship to [redacted address], Boston."],
      ["The museum is 1071 Fifth Avenue, New York.", "The museum is [redacted address], New York."],
      ["Bill to 42 Wallaby Way Apt 3, Sydney.", "Bill to [redacted address], Sydney."],
      ["Our new place is 250 W 57th St #1200.", "Our new place is [redacted address]."],
      ["meet at 88 colfax ave tonight", "meet at [redacted address] tonight"],
      ["SHIP TO 1600 PENNSYLVANIA AVE NW", "SHIP TO [redacted address] NW"],
      ["MAIL TO 12 OAK ST APT 4B", "MAIL TO [redacted address]"],
    ];
    expect(
      Object.fromEntries(cases.map(([input]) => [input, inspectMemoryContent(input).content])),
    ).toEqual(Object.fromEntries(cases));
  });

  it("leaves a number, a lowercase unit, and a street word in prose alone", () => {
    const phrases = [
      "It takes 45 minutes each way.",
      "The commute is 1.5 hours each way.",
      "It is a 3 hour drive.",
      "We drove 3 miles down the road.",
      "Walk 5 blocks up the street and turn left.",
      "Drive 20 minutes down the road, then park.",
      "Two of us take 4 days each way by road.",
      "It took 30 minutes to drive across town.",
      "She ran 26.2 miles along the parkway.",
      "It is a 5 mile drive.",
      "It is a 30 second drive to the beach.",
      "We planned a 9 mile road trip.",
      "That reply took 3 seconds way too long.",
      "I walked 3 miles on Main Street today.",
      "We waited 20 minutes on the highway.",
      "The office is 10 minutes up the road.",
      "It's a 2 hour drive to the lake.",
      "We live 5 km down the road.",
      "The store is 2 blocks down the street.",
      "It took 3 days on the highway.",
      "He jogs 4 miles along the boulevard every morning.",
      "She waited 15 mins at the court.",
      "We parked 100 yards up the lane.",
      "The trail runs 2 kilometres along the parkway.",
      "The school is a 10 minute walk up the street.",
      "It's 20 feet across the road.",
      "Takes 2 hrs each way on the highway.",
      "The bus takes 40 minutes each way.",
      "It is 5 steps down the drive.",
      "The light changes every 90 seconds on this avenue.",
      "It was 2 weeks on the road.",
      "We spent 4 years on that street.",
      "It's a 15 min drive.",
      "It's 400 meters down the road.",
      "Allow 2 hours each way for the drive.",
      "It took 12 secs to cross the street.",
      "They walked 1 mile along the highway.",
      "We drove it 3 times the long way.",
      "Our cabin is a 3 km drive from the lake.",
      "It is a 40 minute drive to the airport.",
    ];
    expect(phrases.map((content) => inspectMemoryContent(content).content)).toEqual(phrases);
  });

  it("leaves other ordinary phrases alone", () => {
    const phrases = [
      "We had 2 drinks on the way home.",
      "We need 2 more chairs for the Main Street fair.",
      "Turn left after 3 lights onto the highway.",
      "Exit 12 is the fastest way downtown.",
      "Our 3 kids walk the lane behind school.",
      "Those 2 tickets were way more than we paid.",
      "Book 2 rooms near the boulevard.",
      "Order 4 pizzas for the Oak Street party.",
      "There are 6 lanes on that highway.",
      "I scored 10 points on the court.",
      "Buy 3 more boxes for the drive.",
      "We saw 12 deer in the road.",
      "Read 5 chapters of Drive this week.",
      "Add 2 eggs and stir the way you like.",
      "I owe you 50 bucks for the road trip.",
      "Plant 8 trees along the avenue.",
      "Take 2 Advil and rest the way the doctor said.",
      "We have 7 Slack channels for the drive project.",
    ];
    expect(phrases.map((content) => inspectMemoryContent(content).content)).toEqual(phrases);
  });

  it("still redacts ordinary text shaped like a house number, a name, and a street type", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["I gave it 5 stars way too quickly.", "I gave it [redacted address] too quickly."],
      ["I have 2 Dr appointments this week.", "I have [redacted address] appointments this week."],
      [
        "Share the 4 Google Drive folders with Sam.",
        "Share the [redacted address] folders with Sam.",
      ],
      [
        "Chapter 7 Highway Patrol notes are due.",
        "Chapter [redacted address] Patrol notes are due.",
      ],
      ["Version 3 Parkway release is next.", "Version [redacted address] release is next."],
      ["She bought 3 new road bikes.", "She bought [redacted address] bikes."],
      ["We booked 2 tennis court slots.", "We booked [redacted address] slots."],
      ["Headline: A 3 Hour Drive", "Headline: A [redacted address]"],
    ];
    expect(
      Object.fromEntries(cases.map(([input]) => [input, inspectMemoryContent(input).content])),
    ).toEqual(Object.fromEntries(cases));
  });

  it("approves normalized internal memory", () => {
    expect(inspectMemoryContent("  Deploy only during the Tuesday window.  ")).toEqual({
      content: "Deploy only during the Tuesday window.",
      redacted: false,
      reviewStatus: "approved",
      sensitivity: "internal",
    });
  });

  it("constrains memory search keys before external indexing", () => {
    expect(validateMemorySearchKey("custom:operations/v1")).toBe("custom:operations/v1");
    expect(() => validateMemorySearchKey("custom:owner@example.com")).toThrow("personal data");
    expect(() => validateMemorySearchKey("custom:sk-example-secret-value-123456")).toThrow(
      "secret-like",
    );
    expect(() => validateMemorySearchKey("custom key with spaces")).toThrow("1 to 200");
  });

  it("ports bounded post-run flush extraction", () => {
    expect(
      buildMemoryFlushPrompt({
        memoryMode: "workspace",
        recentMessages: [{ content: "Deploy on Tuesdays", role: "user" }],
      }),
    ).toContain("Enabled memory mode: workspace");
    expect(
      parseMemoryFlushCandidates(
        '```json\n{"memories":[{"content":"Deploy on Tuesdays","scope":"workspace"},{"content":"Deploy on Tuesdays"}]}\n```',
      ),
    ).toEqual([{ content: "Deploy on Tuesdays", scope: "workspace" }]);
    expect(shouldRunMemoryFlush({ memoryMode: "workspace", recentMessageCount: 2 })).toBe(true);
    expect(shouldRunMemoryFlush({ memoryMode: "workspace", recentMessageCount: 1 })).toBe(false);
    const prompt = buildMemoryFlushPrompt({
      memoryMode: "workspace",
      recentMessages: Array.from({ length: 40 }, (_, index) => ({
        content: `message-${index}|`.padEnd(20_000, "x"),
        role: "user",
      })),
    });
    const transcript =
      prompt.split("Current run transcript (use for durable memory extraction):\n")[1] ?? "";
    expect(transcript.length).toBeLessThanOrEqual(MEMORY_FLUSH_MAX_TRANSCRIPT_CHARS);
    expect(transcript).toContain("message-39|");
    expect(transcript).not.toContain("message-0|");
  });

  it("keeps partial checkpoint offsets on Unicode scalar boundaries", () => {
    expect(
      selectMemoryFlushMessageBatch({
        checkpointMode: "auto",
        maximumCharacters: "user: ".length + 2,
        recentMessages: [{ content: "a😀b", role: "user" }],
      }),
    ).toEqual([
      {
        consumedCharacters: 1,
        message: { content: "a", role: "user" },
        sourceCharacters: 4,
      },
    ]);
  });

  it("distinguishes a valid empty flush from malformed model output", () => {
    expect(parseMemoryFlushCompletion('{"memories":[]}')).toEqual([]);
    expect(() => parseMemoryFlushCompletion("not json")).toThrow("not valid JSON");
    expect(() => parseMemoryFlushCompletion('{"items":[]}')).toThrow("memories array");
    expect(parseMemoryFlushResult('{"memories":[{"scope":"thread"}]}')).toEqual({
      memories: [],
      rejected: [{ index: 0, reason: "Memory content is missing." }],
    });
    expect(
      parseMemoryFlushCandidates(
        '{"memories":[{"content":"Temporary guidance","validUntil":"not-a-timestamp"}]}',
      ),
    ).toEqual([]);
  });

  it("drops an invalid flushed memory without rejecting the rest of the batch", () => {
    const completion = JSON.stringify({
      memories: [
        { content: "Deploys run on Tuesdays.", memoryType: "fact" },
        {
          content: "Visited the Lisbon office on 2026-03-04.",
          memoryType: "episode",
          validFrom: "2026-03-04T00:00:00Z",
          validUntil: "2026-03-04T00:00:00.000Z",
        },
        {
          content: "Prefers morning standups.",
          validFrom: "2026-01-01T00:00:00Z",
          validUntil: null,
        },
        {
          content: "On call this week.",
          validFrom: "2026-03-10T00:00:00Z",
          validUntil: "2026-03-03T00:00:00Z",
        },
        {
          content: "Freeze deploys until the audit ends.",
          validFrom: null,
          validUntil: "2026-04-01T00:00:00Z",
        },
      ],
    });

    expect(parseMemoryFlushResult(completion)).toEqual({
      memories: [
        { content: "Deploys run on Tuesdays.", memoryType: "fact" },
        {
          content: "Visited the Lisbon office on 2026-03-04.",
          memoryType: "episode",
          validFrom: "2026-03-04T00:00:00.000Z",
        },
        { content: "Prefers morning standups.", validFrom: "2026-01-01T00:00:00.000Z" },
        {
          content: "Freeze deploys until the audit ends.",
          validUntil: "2026-04-01T00:00:00.000Z",
        },
      ],
      rejected: [{ index: 3, reason: "Memory validUntil precedes validFrom." }],
    });
  });

  it("builds and parses a bounded rolling conversation checkpoint", () => {
    const prompt = buildMemoryFlushPrompt({
      checkpointMode: "auto",
      memoryMode: "agent",
      previousCheckpoint: "Rowan prefers teasing energy.",
      previousCheckpointFromCreatedAt: "2026-08-09T17:00:00.000Z",
      previousCheckpointThroughCreatedAt: "2026-08-10T17:00:00.000Z",
      recentMessages: [
        {
          content: "My interview is tomorrow.",
          createdAt: "2026-08-10T18:30:00.000Z",
          role: "user",
        },
        {
          content: "I'll check in after it.",
          createdAt: "2026-08-10T18:31:00.000Z",
          role: "assistant",
        },
      ],
    });
    expect(prompt).toContain("Previous checkpoint:\nRowan prefers teasing energy.");
    expect(prompt).toContain(
      "Previous checkpoint source-time bounds: 2026-08-09T17:00:00.000Z through 2026-08-10T17:00:00.000Z.",
    );
    expect(prompt).toContain("unresolved commitments");
    expect(prompt).toContain("Timestamps prefixed to transcript messages are trusted");
    expect(prompt).toContain("resolve relative-time phrases against the timestamp");
    expect(prompt).toContain("validFrom and validUntil describe when a claim is true");
    expect(prompt).toContain("[2026-08-10T18:30:00.000Z] user: My interview is tomorrow.");
    expect(
      parseMemoryFlushResult(
        JSON.stringify({
          checkpoint: "Rowan prefers teasing energy and has an interview tomorrow.",
          memories: [],
        }),
      ),
    ).toEqual({
      checkpoint: "Rowan prefers teasing energy and has an interview tomorrow.",
      memories: [],
      rejected: [],
    });
  });
});
