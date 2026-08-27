"""
The floor, with an interval on it.

One shuffle of a five-hundred-track pool is itself a noisy estimate — the same
random baseline reported anywhere between 11% and 16% at rank 25 depending on
nothing but how many other rankers drew from the shared generator first. This
runs 120 independent shuffles so a result can be compared against a band rather
than a single lucky or unlucky draw.

Anything whose score falls inside this band has not been shown to beat chance.
"""
import hashlib, statistics
import recsim3 as R3

SEEDS = 120


def seeded(seed):
    def rec(me, friends, pool, rng, **kw):
        return {t: int(hashlib.blake2b(f"{seed}:{t}".encode(), digest_size=8).hexdigest(), 16)
                for t in pool}
    return rec


if __name__ == '__main__':
    recs = {f"r{s}": seeded(s) for s in range(SEEDS)}
    usable = [q for q in R3.walk(recs) if q['reachable']]

    def band(rows, k):
        hr = [sum(1 for q in rows if q['ranks'][f"r{s}"] <= k) / len(rows) * 100 for s in range(SEEDS)]
        return statistics.mean(hr), sorted(hr)[3], sorted(hr)[-4]

    def mrr(rows):
        m = [statistics.mean(1 / q['ranks'][f"r{s}"] for q in rows) for s in range(SEEDS)]
        return statistics.mean(m), sorted(m)[3], sorted(m)[-4]

    for label, rows in [
        ("all", usable),
        ("deepening", [q for q in usable if q['known_artist']]),
        ("new artist", [q for q in usable if not q['known_artist']]),
    ]:
        h10, h25, mm = band(rows, 10), band(rows, 25), mrr(rows)
        print(f"{label:12} n={len(rows):3}  "
              f"HR@10 {h10[0]:5.1f}% [{h10[1]:.1f}-{h10[2]:.1f}]   "
              f"HR@25 {h25[0]:5.1f}% [{h25[1]:.1f}-{h25[2]:.1f}]   "
              f"MRR {mm[0]:.4f} [{mm[1]:.4f}-{mm[2]:.4f}]")
