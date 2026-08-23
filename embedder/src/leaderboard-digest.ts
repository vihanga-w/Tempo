/**
 * Telling someone they have moved up the leaderboard.
 *
 * Sent once a day rather than the moment it happens. Two friends listening at
 * similar rates cross back and forth over an afternoon, and a notification for
 * each one is noise about something that keeps un-happening. Comparing where
 * somebody stands now against where they stood yesterday says the same thing
 * once, and only when it is still true.
 *
 * That also removes the need to watch for crossings at all. Nothing has to be
 * latched or queued: the standing itself is the record.
 */

/** Who was ahead of a reader when their standing was last recorded. */
export interface Standing {
    /** Friends ahead of them, by id. */
    aheadOfMe: string[];
    position: number;
    takenAt: number;
}

export interface DigestNotification {
    title: string;
    message: string;
}

export interface Digest {
    /** Friends passed since the last standing, by id. */
    passed: string[];
    /** Absent when there is nothing worth sending. */
    notification?: DigestNotification;
}

/** "Alex" / "Alex and Sam" / "Alex, Sam and 2 others" */
function joinNames(names: string[]): string {
    if (names.length === 0)
        return "";

    if (names.length === 1)
        return names[0];

    if (names.length <= 3)
        return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

    return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

/**
 * What to tell a reader about where they now stand.
 *
 * Only moving up is reported. Being told somebody has passed you is a nudge
 * about something you did not do, which is a poor thing to wake a phone for, and
 * a rolling week means a position can slip purely because old listening has
 * aged out of it — a change nobody caused and nobody can act on.
 *
 * Somebody who was not on the board last time cannot have been passed, so they
 * are ignored rather than counted: a friend added yesterday would otherwise read
 * as an overtake this morning.
 */
export function buildDigest(options: {
    previous?: Standing;
    currentlyAhead: string[];
    position: number;
    /** Everyone on the board now, so departures are not read as overtakes. */
    presentNow: string[];
    nameFor: (userId: string) => string;
}): Digest {
    const { previous, currentlyAhead, position, presentNow, nameFor } = options;

    // Nothing to compare against on the first run. Recording where they stand is
    // the whole of the work.
    if (!previous)
        return { passed: [] };

    const ahead = new Set(currentlyAhead);
    const present = new Set(presentNow);

    const passed = previous.aheadOfMe.filter(id => present.has(id) && !ahead.has(id));

    if (passed.length === 0)
        return { passed: [] };

    const names = joinNames(passed.map(nameFor));

    if (position === 1) {
        return {
            passed,
            notification: {
                title: "🏆 Top of the leaderboard",
                message: `You passed ${names}. Nobody's listened more in the past week.`,
            },
        };
    }

    return {
        passed,
        notification: {
            title: "📈 You moved up",
            message: `You passed ${names}. You're ${ordinal(position)} on the leaderboard.`,
        },
    };
}

/** "2nd", "3rd", "11th" — for a position in a sentence. */
export function ordinal(position: number): string {
    const lastTwo = position % 100;

    if (lastTwo >= 11 && lastTwo <= 13)
        return `${position}th`;

    switch (position % 10) {
        case 1: return `${position}st`;
        case 2: return `${position}nd`;
        case 3: return `${position}rd`;
        default: return `${position}th`;
    }
}
