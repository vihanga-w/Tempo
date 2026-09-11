/**
 * Reference inputs and outputs for the song-vector port.
 *
 * The inputs are Deezer-shaped tracks, albums and artists chosen to reach every
 * branch of research/song-vector/songvec.py: a genre outside the vocabulary, an
 * album that could not be read, a year-only date, "0000-00-00", zero gain, a BPM
 * of zero, gain and BPM past their clamps, an explicit-content value above 4.
 *
 * The outputs are what songvec.py itself returned for them, with the committed
 * genre-vocab.json and these six tracks as the corpus:
 *
 *     songvec._set_vocabulary(songvec.load_vocabulary("genre-vocab.json"))
 *     sv = songvec.SongVectors(tracks, albums, artists, None)
 *     vectors = [sv.vector(t) for t in tracks.values()]
 *
 * Regenerate them that way if songvec.py changes, never by hand. The Python
 * vectors are float32, so they agree with the port to about 1e-7, not exactly.
 */

/* eslint-disable */

export const PARITY_FIXTURE: {
    tracks: { [key: string]: any };
    albums: { [id: string]: any };
    artists: { [id: string]: any };
} = {
    "tracks": {
        "full": {
            "id": 1001,
            "isrc": "GBAAA2600001",
            "duration": 245,
            "rank": 612345,
            "release_date": "2026-09-04",
            "explicit_lyrics": false,
            "explicit_content_lyrics": 0,
            "gain": -8.2,
            "bpm": 0,
            "contributors": [
                {
                    "id": 1
                },
                {
                    "id": 2
                }
            ],
            "album": {
                "id": 501
            },
            "artist": {
                "id": 301
            }
        },
        "other_genre": {
            "id": 1002,
            "isrc": "GBAAA1900002",
            "duration": 95,
            "rank": 1500,
            "release_date": "2019-03-15",
            "explicit_lyrics": true,
            "explicit_content_lyrics": 1,
            "gain": 0,
            "bpm": 128,
            "contributors": [
                {
                    "id": 1
                }
            ],
            "album": {
                "id": 502
            },
            "artist": {
                "id": 302
            }
        },
        "no_album": {
            "id": 1003,
            "isrc": "USAAA9800003",
            "duration": 400,
            "rank": 0,
            "release_date": "1998-11-02",
            "explicit_lyrics": false,
            "contributors": [],
            "album": {
                "id": 503
            },
            "artist": {
                "id": 303
            }
        },
        "year_only": {
            "id": 1004,
            "isrc": "USAAA1000004",
            "duration": 180,
            "rank": 250000,
            "release_date": "2010",
            "explicit_content_lyrics": 2,
            "gain": -25,
            "bpm": 210,
            "contributors": [
                {
                    "id": 1
                },
                {
                    "id": 2
                },
                {
                    "id": 3
                },
                {
                    "id": 4
                },
                {
                    "id": 5
                },
                {
                    "id": 6
                },
                {
                    "id": 7
                },
                {
                    "id": 8
                },
                {
                    "id": 9
                }
            ],
            "album": {
                "id": 504
            },
            "artist": {
                "id": 304
            }
        },
        "zero_date": {
            "id": 1005,
            "isrc": "FRAAA0100005",
            "duration": 0,
            "rank": 900000,
            "release_date": "2001-01-01",
            "explicit_content_lyrics": 6,
            "gain": 5,
            "bpm": 90,
            "contributors": [
                {
                    "id": 1
                },
                {
                    "id": 2
                },
                {
                    "id": 3
                }
            ],
            "album": {
                "id": 505
            },
            "artist": {
                "id": 305
            }
        },
        "track_date": {
            "id": 1006,
            "isrc": "SEAAA2400006",
            "duration": 331,
            "rank": 42000,
            "release_date": "2024-12-31",
            "explicit_lyrics": true,
            "explicit_content_lyrics": 4,
            "gain": -20,
            "bpm": 60,
            "contributors": [
                {
                    "id": 1
                },
                {
                    "id": 2
                }
            ],
            "album": {
                "id": 506
            },
            "artist": {
                "id": 306
            }
        }
    },
    "albums": {
        "501": {
            "id": 501,
            "genres": {
                "data": [
                    {
                        "name": "Pop"
                    },
                    {
                        "name": "Dance"
                    }
                ]
            },
            "release_date": "2026-09-04"
        },
        "502": {
            "id": 502,
            "genres": {
                "data": [
                    {
                        "name": "Rap/Hip Hop"
                    },
                    {
                        "name": "Grime"
                    }
                ]
            },
            "release_date": "2019-03-15"
        },
        "504": {
            "id": 504,
            "genres": {
                "data": []
            },
            "release_date": "2010"
        },
        "505": {
            "id": 505,
            "genres": {
                "data": [
                    {
                        "name": "Film Scores"
                    },
                    {
                        "name": "Films/Games"
                    },
                    {
                        "name": "Christian"
                    }
                ]
            },
            "release_date": "0000-00-00"
        },
        "506": {
            "id": 506,
            "genres": {
                "data": [
                    {
                        "name": "Pop"
                    }
                ]
            }
        }
    },
    "artists": {
        "301": {
            "id": 301,
            "nb_fan": 1260527
        },
        "302": {
            "id": 302,
            "nb_fan": 5400
        },
        "303": {
            "id": 303,
            "nb_fan": 0
        },
        "305": {
            "id": 305,
            "nb_fan": 99
        },
        "306": {
            "id": 306,
            "nb_fan": 300000
        }
    }
};

export const PARITY_EXPECTED: { dims: string[]; vectors: { [key: string]: number[] } } = {
    dims: ["genre:Rap/Hip Hop","genre:Pop","genre:Alternative","genre:R&B","genre:Dance","genre:Rock","genre:Electro","genre:Country","genre:Indie Pop","genre:Indie Rock","genre:Films/Games","genre:Film Scores","genre:Singer & Songwriter","genre:Techno/House","genre:Latin Music","genre:International Pop","genre:Reggae","genre:Folk","genre:Indie Rock/Rock Pop","genre:Contemporary R&B","genre:African Music","genre:Soul & Funk","genre:Dancehall/Ragga","genre:Indie Pop/Folk","genre:Asian Music","genre:Christian","genre:other","genre:present","age_log","release_month_sin","release_month_cos","release_present","rank_pct","fans_log","artist_present","duration_log","duration_short","duration_long","explicit","explicit_present","contributors_log","featured","gain","gain_present","bpm","bpm_present"],
    vectors: {
        "full": [0, 0.5, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, -1, -1.8369701465288538e-16, 1, 0.6000000238418579, 1, 1, 0.8603969216346741, 0, 0, 0, 1, 0.5, 1, 0.5899999737739563, 1, 0, 0],
        "other_genre": [0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 1, 0.487824946641922, 1, 6.123234262925839e-17, 1, 0, 0.6118255853652954, 1, 0.7133359909057617, 1, 0, 0.25, 1, 0.31546488404273987, 0, 1, 1, 0.48571428656578064, 1],
        "no_album": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.7899481058120728, -0.5, 0.8660253882408142, 1, 0, 0, 0, 0.9367621541023254, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0],
        "year_only": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4000000059604645, 0, 0, 0.8124435544013977, 0, 0, 0.5, 1, 1, 1, 0, 1, 1, 1],
        "zero_date": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3333333432674408, 0.3333333432674408, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3333333432674408, 0, 1, 0, 0, 0, 0, 0.800000011920929, 0.3278391659259796, 1, 0, 0, 0, 1, 1, 0.6309297680854797, 1, 1, 1, 0.2142857164144516, 1],
        "track_date": [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0.25772807002067566, -2.4492937051703357e-16, 1, 1, 0.20000000298023224, 0.8978076577186584, 1, 0.9072515368461609, 0, 1, 1, 1, 0.5, 1, 0, 1, 0, 1],
    },
};
