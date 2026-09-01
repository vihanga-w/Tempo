import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    stampsToAnnounce, stampNotice, REPEAT_MILESTONE, StampTally,
} from "./passport-notify";
import type { PassportCountry } from "./passport";

function country(code: string, name: string, stampCount: number): PassportCountry {
    return {
        countryCode: code, name, lat: 0, lon: 0, continent: "Europe",
        stampCount, firstAt: 1, lastAt: 2,
    };
}

const FR = country("FR", "France", 1);
const NG = country("NG", "Nigeria", 1);

describe("what to announce", () => {
    it("says nothing at all the first time an account is seen", () => {
        // Otherwise every stamp anybody ever earned arrives the first time this
        // runs, as a dozen notifications about weeks-old listening.
        const check = stampsToAnnounce(null, [FR, NG]);

        assert.equal(check.seeded, true);
        assert.deepEqual(check.announce, []);
        assert.deepEqual(check.remember, { FR: 1, NG: 1 });
    });

    it("tells the difference between never seen and seen with nothing", () => {
        const check = stampsToAnnounce({}, [FR]);

        assert.equal(check.seeded, false);
        assert.equal(check.announce.length, 1);
        assert.equal(check.announce[0].kind, "new");
    });

    it("announces a country the first time it is stamped", () => {
        const check = stampsToAnnounce({ FR: 1 }, [FR, NG]);

        assert.deepEqual(check.announce.map(e => e.country.countryCode), ["NG"]);
    });

    it("stays quiet about an ordinary repeat", () => {
        const check = stampsToAnnounce({ FR: 1 }, [country("FR", "France", 2)]);

        assert.deepEqual(check.announce, []);
        assert.deepEqual(check.remember, { FR: 2 });
    });

    it("speaks up on every tenth stamp from one country", () => {
        for (const n of [REPEAT_MILESTONE, REPEAT_MILESTONE * 2, REPEAT_MILESTONE * 3]) {
            const check = stampsToAnnounce(
                { FR: n - 1 }, [country("FR", "France", n)],
            );

            assert.equal(check.announce.length, 1, `should announce at ${n}`);
            assert.equal(check.announce[0].kind, "milestone");
        }
    });

    it("does not miss a milestone stepped over between sweeps", () => {
        // Nine to eleven in one go still crossed the line
        const check = stampsToAnnounce({ FR: 9 }, [country("FR", "France", 11)]);

        assert.equal(check.announce.length, 1);
        assert.equal(check.announce[0].count, 11);
    });

    it("does not announce a milestone twice", () => {
        const check = stampsToAnnounce({ FR: 10 }, [country("FR", "France", 10)]);

        assert.deepEqual(check.announce, []);
    });

    it("remembers the whole tally, not only what it announced", () => {
        const previous: StampTally = { FR: 3 };
        const check = stampsToAnnounce(previous, [country("FR", "France", 4), NG]);

        assert.deepEqual(check.remember, { FR: 4, NG: 1 });
    });
});

describe("what to say", () => {
    it("says nothing when there is nothing", () => {
        assert.equal(stampNotice([], 0), null);
    });

    it("treats a first ever stamp as a beginning, not a total", () => {
        const notice = stampNotice([{ country: FR, kind: "new", count: 1 }], 1);

        assert.equal(notice?.title, "Your first stamp");
        assert.ok(notice?.message.includes("France"));
        assert.ok(!notice?.message.includes("1 countries"));
    });

    it("gives a running total for a later country", () => {
        const notice = stampNotice([{ country: NG, kind: "new", count: 1 }], 7);

        assert.equal(notice?.title, "Nigeria stamped");
        assert.ok(notice?.message.includes("7 countries"));
    });

    it("names several at once", () => {
        const notice = stampNotice([
            { country: FR, kind: "new", count: 1 },
            { country: NG, kind: "new", count: 1 },
        ], 9);

        assert.equal(notice?.title, "Two new stamps");
        assert.ok(notice?.message.includes("France and Nigeria"));
    });

    it("counts the rest rather than listing them", () => {
        const many = ["FR", "NG", "SE", "JP", "BR"].map((c, i) => ({
            country: country(c, `Country${i}`, 1), kind: "new" as const, count: 1,
        }));

        const notice = stampNotice(many, 12);

        assert.ok(notice?.message.includes("and 2 more"), notice?.message);
    });

    it("says how many months a milestone is", () => {
        const notice = stampNotice(
            [{ country: country("FR", "France", 10), kind: "milestone", count: 10 }], 6,
        );

        assert.equal(notice?.title, "Ten stamps from France");
        assert.ok(notice?.message.includes("separate months"));
    });

    it("lets somewhere new outrank a milestone", () => {
        // Two notifications at once for one feature is how people switch a
        // feature's notifications off.
        const notice = stampNotice([
            { country: country("FR", "France", 10), kind: "milestone", count: 10 },
            { country: NG, kind: "new", count: 1 },
        ], 8);

        assert.equal(notice?.title, "Nigeria stamped");
    });
});
