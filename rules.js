// Grammar rules. Each rule returns an array of {index, length, type, message, explanation, example, fix} objects.

const RULES = [
  // ─── Comma splice ───────────────────────────────────────────────────────────
  {
    id: "comma-splice",
    check(text) {
      const findings = [];
      // Two independent clauses joined only by a comma (no coordinating conjunction)
      const re = /([A-Z][^.!?]*[a-z]),\s+([A-Z][^.!?]*[a-z])/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        // Heuristic: both sides contain a verb-like word
        const left = m[1];
        const right = m[2];
        if (hasVerb(left) && hasVerb(right)) {
          findings.push({
            index: m.index + left.length,
            length: 1,
            type: "comma-splice",
            severity: "warning",
            label: "Comma splice",
            message: `A comma is joining two complete sentences here.`,
            explanation:
              "A comma splice happens when two independent clauses (sentences that could stand alone) are joined with just a comma. This is considered a grammatical error in formal writing.",
            example:
              "❌  I went to the store, I bought milk.\n✅  I went to the store. I bought milk.\n✅  I went to the store, and I bought milk.\n✅  I went to the store; I bought milk.",
            fix: "Replace the comma with a period, a semicolon, or add a coordinating conjunction (and, but, or, nor, for, yet, so).",
          });
        }
      }
      return findings;
    },
  },

  // ─── Missing Oxford / serial comma ──────────────────────────────────────────
  {
    id: "oxford-comma",
    check(text) {
      const findings = [];
      // Pattern: word, word and word  (no comma before "and")
      const re = /(\b\w+),\s+(\w+)\s+and\s+(\w+)\b/gi;
      let m;
      while ((m = re.exec(text)) !== null) {
        findings.push({
          index: m.index + m[0].lastIndexOf(" and"),
          length: 4,
          type: "oxford-comma",
          severity: "info",
          label: "Oxford comma",
          message: `Consider adding a comma before "and" in this list.`,
          explanation:
            'The Oxford (serial) comma is a comma placed before the final "and" or "or" in a list of three or more items. Many style guides (APA, Chicago) require it to prevent ambiguity.',
          example:
            "Without: I love my parents, Lady Gaga and Humpty Dumpty.\n  (Are Lady Gaga and Humpty Dumpty your parents?)\nWith: I love my parents, Lady Gaga, and Humpty Dumpty.",
          fix: `Add a comma before "and": "…${m[2]}, and ${m[3]}…"`,
        });
      }
      return findings;
    },
  },

  // ─── Missing comma after introductory clause ─────────────────────────────────
  {
    id: "intro-clause-comma",
    check(text) {
      const findings = [];
      const introWords = [
        "however", "therefore", "furthermore", "moreover", "nevertheless",
        "consequently", "additionally", "meanwhile", "otherwise", "thus",
        "hence", "indeed", "instead", "similarly", "accordingly",
      ];
      const re = new RegExp(
        `(?:^|[.!?]\\s+)(${introWords.join("|")})(\\s+[a-z])`,
        "gi"
      );
      let m;
      while ((m = re.exec(text)) !== null) {
        const word = m[1];
        findings.push({
          index: m.index + (m[0].length - m[2].length - word.length),
          length: word.length,
          type: "intro-clause-comma",
          severity: "warning",
          label: "Missing comma",
          message: `"${word}" at the start of a sentence usually needs a comma after it.`,
          explanation:
            'Conjunctive adverbs like "however," "therefore," and "furthermore" need a comma after them when they appear at the start of a sentence. This signals a pause and keeps the sentence readable.',
          example: `❌  However I disagree.\n✅  However, I disagree.`,
          fix: `Add a comma after "${word}".`,
        });
      }
      return findings;
    },
  },

  // ─── Apostrophe: its vs it's ────────────────────────────────────────────────
  {
    id: "its-its",
    check(text) {
      const findings = [];
      // "it's" used as possessive
      const reContraction = /\bit's\s+(?:own|name|size|color|colour|way|form|place|role|part|turn|job|purpose|effect)\b/gi;
      let m;
      while ((m = reContraction.exec(text)) !== null) {
        findings.push({
          index: m.index,
          length: 4,
          type: "its-its",
          severity: "error",
          label: "its vs it's",
          message: `"it's" here should be "its" (possessive).`,
          explanation:
            '"it\'s" is a contraction of "it is" or "it has." "its" (no apostrophe) is the possessive form. A simple test: read the sentence with "it is" — if it sounds wrong, use "its."',
          example:
            '❌  The dog wagged it\'s tail.\n✅  The dog wagged its tail.\n✅  It\'s raining outside. (= "It is raining")',
          fix: 'Replace "it\'s" with "its."',
        });
      }
      // "its" used as contraction
      const reIts = /\bits\s+(?:a|an|the|not|been|going|time|easy|hard|true|false|clear|possible|impossible|okay|ok)\b/gi;
      while ((m = reIts.exec(text)) !== null) {
        findings.push({
          index: m.index,
          length: 3,
          type: "its-its",
          severity: "error",
          label: "its vs it's",
          message: `"its" here looks like it should be "it's" (it is / it has).`,
          explanation:
            '"it\'s" is a contraction of "it is" or "it has." "its" (no apostrophe) is the possessive form.',
          example:
            '❌  Its going to rain.\n✅  It\'s going to rain. (= "It is going to rain")',
          fix: 'Replace "its" with "it\'s."',
        });
      }
      return findings;
    },
  },

  // ─── their / there / they're ────────────────────────────────────────────────
  {
    id: "there-their-theyre",
    check(text) {
      const findings = [];
      // "their" used where "there" is expected (after "is/are/was/were")
      const reTheirThere = /\b(is|are|was|were|over|out|down|up|back|right|left|away)\s+their\b/gi;
      let m;
      while ((m = reTheirThere.exec(text)) !== null) {
        const start = m.index + m[1].length + 1;
        findings.push({
          index: start,
          length: 5,
          type: "there-their-theyre",
          severity: "error",
          label: "their / there / they're",
          message: `"their" may be wrong here — did you mean "there"?`,
          explanation:
            '"there" refers to a place or introduces a sentence ("There is…"). "their" shows possession (belonging to them). "they\'re" = they are.',
          example:
            '❌  Is their a problem?\n✅  Is there a problem?\n✅  Their car is blue. (possession)\n✅  They\'re coming tomorrow. (= "They are")',
          fix: 'Use "there" to refer to a place or use "is/are there…"',
        });
      }
      // "there" used as possessive (before a noun)
      const reTherePoss = /\bthere\s+(?:own|house|car|dog|cat|team|school|book|bag|job|idea|plan|group|family|friend|phone)\b/gi;
      while ((m = reTherePoss.exec(text)) !== null) {
        findings.push({
          index: m.index,
          length: 5,
          type: "there-their-theyre",
          severity: "error",
          label: "their / there / they're",
          message: `"there" looks like it should be "their" (possessive).`,
          explanation:
            '"their" shows possession. "there" refers to a place or introduces clauses.',
          example:
            '❌  I like there house.\n✅  I like their house.',
          fix: 'Replace "there" with "their."',
        });
      }
      return findings;
    },
  },

  // ─── your / you're ──────────────────────────────────────────────────────────
  {
    id: "your-youre",
    check(text) {
      const findings = [];
      // "your" where "you're" is expected
      const reYour = /\byour\s+(?:a|an|the|not|going|welcome|right|wrong|sure|ready|done|able|allowed|supposed|trying|kidding|joking|serious|crazy|awesome|amazing|great|terrible|wrong|correct|late|early|free|busy|tired|sick|excited|happy|sad|angry|nervous|lucky|smart|funny|wrong)\b/gi;
      let m;
      while ((m = reYour.exec(text)) !== null) {
        findings.push({
          index: m.index,
          length: 4,
          type: "your-youre",
          severity: "error",
          label: "your vs you're",
          message: `"your" here looks like it should be "you're" (you are).`,
          explanation:
            '"you\'re" is a contraction of "you are." "your" is possessive (belonging to you). Test: replace with "you are" — if it makes sense, use "you\'re."',
          example:
            '❌  Your going to love this.\n✅  You\'re going to love this.\n✅  Your dog is cute. (possession)',
          fix: 'Replace "your" with "you\'re."',
        });
      }
      // "you're" used possessively
      const reYoure = /\byou're\s+(?:friend|dog|cat|car|house|phone|bag|book|team|school|job|idea|plan|family|boss|teacher|mom|dad|brother|sister|name|email|number|address|account|password|choice|decision|problem|fault|responsibility|turn|time|money|life|story|opinion|point|question|answer)\b/gi;
      while ((m = reYoure.exec(text)) !== null) {
        findings.push({
          index: m.index,
          length: 6,
          type: "your-youre",
          severity: "error",
          label: "your vs you're",
          message: `"you're" here looks like it should be "your" (possessive).`,
          explanation:
            '"your" shows possession. "you\'re" = you are.',
          example:
            "❌  I love you're dog.\n✅  I love your dog.",
          fix: 'Replace "you\'re" with "your."',
        });
      }
      return findings;
    },
  },

  // ─── Double negatives ────────────────────────────────────────────────────────
  {
    id: "double-negative",
    check(text) {
      const findings = [];
      const re = /\b(can't|cannot|couldn't|don't|doesn't|didn't|won't|wouldn't|shouldn't|haven't|hasn't|hadn't|isn't|aren't|wasn't|weren't|never|no)\s+(?:\w+\s+){0,3}(nobody|no one|nothing|nowhere|neither|never|none|no)\b/gi;
      let m;
      while ((m = re.exec(text)) !== null) {
        findings.push({
          index: m.index,
          length: m[0].length,
          type: "double-negative",
          severity: "warning",
          label: "Double negative",
          message: "Two negatives make a positive in standard English.",
          explanation:
            "In standard written English, two negative words cancel each other out, resulting in a positive meaning — the opposite of what you likely intended. Double negatives are acceptable in some dialects but should be avoided in formal writing.",
          example:
            "❌  I don't know nothing. (= I know something)\n✅  I don't know anything.\n✅  I know nothing.",
          fix: "Replace one of the negatives with its positive equivalent.",
        });
      }
      return findings;
    },
  },

  // ─── Passive voice (informational) ──────────────────────────────────────────
  {
    id: "passive-voice",
    check(text) {
      const findings = [];
      const re = /\b(is|are|was|were|be|been|being)\s+(\w+ed)\b/gi;
      const actionVerbs = new Set([
        "done", "made", "given", "taken", "seen", "known", "found", "used",
        "told", "shown", "kept", "held", "put", "left", "heard", "read",
        "led", "sent", "brought", "built", "bought", "caught", "taught",
        "written", "spoken", "broken", "chosen", "driven", "grown",
        "thrown", "worn", "eaten", "fallen", "forgotten", "frozen",
        "hidden", "ridden", "risen", "run", "stolen", "sworn", "taken",
        "torn", "woken", "won", "beaten", "begun", "bitten", "blown",
        "borne", "dug", "drawn", "drunk", "fed", "felt", "fought", "flown",
        "forbidden", "forgiven", "gotten", "gone", "hung", "hurt", "kept",
        "laid", "lain", "lit", "lost", "met", "mistaken", "paid", "proven",
        "rung", "said", "shaken", "shot", "shrunk", "shut", "sung", "sunk",
        "sat", "slept", "slid", "snuck", "sold", "spent", "spread", "stood",
        "struck", "strung", "stuck", "swept", "swum", "swung", "thought",
        "understood", "woven", "wept",
      ]);
      let m;
      while ((m = re.exec(text)) !== null) {
        const participle = m[2].toLowerCase();
        if (actionVerbs.has(participle) || participle.endsWith("ed")) {
          findings.push({
            index: m.index,
            length: m[0].length,
            type: "passive-voice",
            severity: "info",
            label: "Passive voice",
            message: `This looks like passive voice ("${m[0]}").`,
            explanation:
              "Passive voice puts the object of an action before the verb. Active voice is usually clearer and more direct because it puts the subject first. Passive voice isn't wrong, but overuse makes writing feel weak or evasive.",
            example:
              '❌ (passive)  The ball was kicked by John.\n✅ (active)   John kicked the ball.',
            fix: "Consider rewriting: who or what performs the action? Put that first.",
          });
        }
      }
      return findings;
    },
  },

  // ─── Sentence-ending preposition (informational) ─────────────────────────────
  {
    id: "ending-preposition",
    check(text) {
      const findings = [];
      const preps = ["with", "in", "on", "at", "by", "for", "of", "to", "up", "off", "out", "about", "from"];
      const re = new RegExp(
        `\\b(${preps.join("|")})\\s*[.!?]`,
        "gi"
      );
      let m;
      while ((m = re.exec(text)) !== null) {
        findings.push({
          index: m.index,
          length: m[1].length,
          type: "ending-preposition",
          severity: "info",
          label: "Sentence-ending preposition",
          message: `Sentence ends with a preposition ("${m[1]}").`,
          explanation:
            'The old "rule" against ending sentences with prepositions is largely considered outdated. Modern style guides allow it, and avoiding it can make sentences awkward. It\'s still flagged in some formal contexts.',
          example:
            'Traditional: "With whom did you speak?"\nNatural: "Who did you speak with?"',
          fix: "In formal writing, try to restructure the sentence. In everyday writing, this is perfectly acceptable.",
        });
      }
      return findings;
    },
  },

  // ─── Common misspellings ─────────────────────────────────────────────────────
  {
    id: "misspelling",
    check(text) {
      const findings = [];
      const misspellings = {
        "accomodate": "accommodate",
        "acheive": "achieve",
        "aquire": "acquire",
        "arguement": "argument",
        "beleive": "believe",
        "calender": "calendar",
        "catagory": "category",
        "cemetary": "cemetery",
        "commitee": "committee",
        "concious": "conscious",
        "consistant": "consistent",
        "definately": "definitely",
        "embarass": "embarrass",
        "enviroment": "environment",
        "existance": "existence",
        "familier": "familiar",
        "finaly": "finally",
        "foriegn": "foreign",
        "freind": "friend",
        "goverment": "government",
        "grammer": "grammar",
        "greatful": "grateful",
        "guarentee": "guarantee",
        "happend": "happened",
        "harass": "harass",
        "ignorence": "ignorance",
        "immediatly": "immediately",
        "independant": "independent",
        "inoculate": "inoculate",
        "inteligence": "intelligence",
        "knowlege": "knowledge",
        "liason": "liaison",
        "lisence": "license",
        "maintanance": "maintenance",
        "managable": "manageable",
        "medeval": "medieval",
        "millenium": "millennium",
        "mischievious": "mischievous",
        "misspell": "misspell",
        "neccessary": "necessary",
        "negociate": "negotiate",
        "noticable": "noticeable",
        "occurance": "occurrence",
        "occured": "occurred",
        "ommit": "omit",
        "orignal": "original",
        "paralel": "parallel",
        "passtime": "pastime",
        "peice": "piece",
        "percieve": "perceive",
        "perseverance": "perseverance",
        "persistant": "persistent",
        "politican": "politician",
        "posession": "possession",
        "prefered": "preferred",
        "prejudice": "prejudice",
        "privelege": "privilege",
        "probly": "probably",
        "pronounciation": "pronunciation",
        "publically": "publicly",
        "questionaire": "questionnaire",
        "recieve": "receive",
        "recomend": "recommend",
        "relavant": "relevant",
        "relevent": "relevant",
        "religous": "religious",
        "repitition": "repetition",
        "resistence": "resistance",
        "responsability": "responsibility",
        "restaraunt": "restaurant",
        "rythm": "rhythm",
        "sargent": "sergeant",
        "seperate": "separate",
        "similer": "similar",
        "successfull": "successful",
        "supercede": "supersede",
        "suprise": "surprise",
        "temperture": "temperature",
        "tendancy": "tendency",
        "tommorrow": "tomorrow",
        "tounge": "tongue",
        "transfered": "transferred",
        "truely": "truly",
        "underrate": "underrate",
        "untill": "until",
        "vaccuum": "vacuum",
        "visious": "vicious",
        "wierd": "weird",
        "whereever": "wherever",
        "writting": "writing",
        "alot": "a lot",
        "alright": "all right",
        "altho": "although",
        "amature": "amateur",
        "apparant": "apparent",
        "arguement": "argument",
        "aswell": "as well",
        "basicly": "basically",
        "buisness": "business",
        "changable": "changeable",
        "collegue": "colleague",
        "comming": "coming",
        "completly": "completely",
        "contraversy": "controversy",
        "corosion": "corrosion",
        "curiousity": "curiosity",
        "developement": "development",
        "differnce": "difference",
        "dilema": "dilemma",
        "disapoint": "disappoint",
        "disasterous": "disastrous",
        "discription": "description",
        "dissapear": "disappear",
        "dosen't": "doesn't",
        "drunkeness": "drunkenness",
        "duely": "duly",
        "dumbell": "dumbbell",
        "electorial": "electoral",
        "eligable": "eligible",
        "elimentary": "elementary",
        "embarrasment": "embarrassment",
        "eminant": "eminent",
        "enterance": "entrance",
        "entitle": "entitle",
        "entrepeneur": "entrepreneur",
        "enviromental": "environmental",
        "equiptment": "equipment",
        "exilerate": "exhilarate",
        "existance": "existence",
        "explaination": "explanation",
        "exuberence": "exuberance",
        "facinating": "fascinating",
        "firey": "fiery",
        "flourescent": "fluorescent",
        "fullfill": "fulfill",
        "glamourous": "glamorous",
        "greatful": "grateful",
        "grievous": "grievous",
        "harrass": "harass",
        "heirarchy": "hierarchy",
        "humerous": "humorous",
        "hygeine": "hygiene",
        "hypocracy": "hypocrisy",
        "immenent": "imminent",
        "incidently": "incidentally",
        "indispensible": "indispensable",
        "interupt": "interrupt",
        "introcude": "introduce",
        "irrelevent": "irrelevant",
        "jewlery": "jewelry",
        "judgement": "judgment",
        "labratory": "laboratory",
        "lenght": "length",
        "lightening": "lightning",
        "lollypop": "lollipop",
        "manuever": "maneuver",
        "memento": "memento",
        "miniscule": "minuscule",
        "mispell": "misspell",
        "momento": "memento",
        "monkies": "monkeys",
        "mustache": "mustache",
        "naieve": "naive",
        "naturaly": "naturally",
        "nineth": "ninth",
        "noisy": "noisy",
        "nowledge": "knowledge",
        "obesely": "obesity",
        "occassion": "occasion",
        "ofcourse": "of course",
        "oportunity": "opportunity",
        "outragous": "outrageous",
        "overun": "overrun",
        "pamflet": "pamphlet",
        "paradigem": "paradigm",
        "parallell": "parallel",
        "particuarly": "particularly",
        "peculier": "peculiar",
        "permanant": "permanent",
        "perpendicular": "perpendicular",
        "perseverence": "perseverance",
        "phenominon": "phenomenon",
        "plagarism": "plagiarism",
        "playright": "playwright",
        "plausable": "plausible",
        "portible": "portable",
        "portugese": "Portuguese",
        "preceed": "precede",
        "predjudice": "prejudice",
        "presense": "presence",
        "prevailent": "prevalent",
        "principel": "principle",
        "priviledge": "privilege",
        "procede": "proceed",
        "procrastinate": "procrastinate",
        "profesional": "professional",
        "prominant": "prominent",
        "pronounciation": "pronunciation",
        "propoganda": "propaganda",
        "psuedo": "pseudo",
        "psychadelic": "psychedelic",
        "publicly": "publicly",
        "pursuade": "persuade",
        "quanity": "quantity",
        "quarentine": "quarantine",
        "questionaire": "questionnaire",
        "raquet": "racket",
        "recognise": "recognize",
        "recomendation": "recommendation",
        "rehersal": "rehearsal",
        "releive": "relieve",
        "religous": "religious",
        "reluctent": "reluctant",
        "rendezvous": "rendezvous",
        "repitoire": "repertoire",
        "rescent": "recent",
        "resistence": "resistance",
        "resturant": "restaurant",
        "rediculous": "ridiculous",
        "roomate": "roommate",
        "sacrilegious": "sacrilegious",
        "schedual": "schedule",
        "secratary": "secretary",
        "sensable": "sensible",
        "simutaneous": "simultaneous",
        "sophmore": "sophomore",
        "speach": "speech",
        "specimin": "specimen",
        "succede": "succeed",
        "suficient": "sufficient",
        "superscede": "supersede",
        "surreal": "surreal",
        "sychophant": "sycophant",
        "symetry": "symmetry",
        "tatoo": "tattoo",
        "technolgy": "technology",
        "therefor": "therefore",
        "treshhold": "threshold",
        "todays": "today's",
        "tommorow": "tomorrow",
        "totaly": "totally",
        "tounament": "tournament",
        "tradgedy": "tragedy",
        "trully": "truly",
        "twelfth": "twelfth",
        "tyrany": "tyranny",
        "tyranical": "tyrannical",
        "ukelele": "ukulele",
        "unnecessery": "unnecessary",
        "untill": "until",
        "usefull": "useful",
        "usualy": "usually",
        "utilise": "utilize",
        "vaccinate": "vaccinate",
        "valueable": "valuable",
        "vegatable": "vegetable",
        "visability": "visibility",
        "volunter": "volunteer",
        "vunerable": "vulnerable",
        "wether": "whether",
        "wich": "which",
        "withhold": "withhold",
        "yatch": "yacht",
        "yeild": "yield",
      };
      const misspellingRe = new RegExp(
        `\\b(${Object.keys(misspellings).join("|")})\\b`,
        "gi"
      );
      let m;
      while ((m = misspellingRe.exec(text)) !== null) {
        const wrong = m[1].toLowerCase();
        const correct = misspellings[wrong];
        if (!correct) continue;
        findings.push({
          index: m.index,
          length: m[1].length,
          type: "misspelling",
          severity: "error",
          label: "Misspelling",
          message: `"${m[1]}" is misspelled.`,
          explanation: `"${m[1]}" is a common misspelling. The correct spelling is "${correct}."`,
          example: `❌  ${m[1]}\n✅  ${correct}`,
          fix: `Change "${m[1]}" to "${correct}."`,
        });
      }
      return findings;
    },
  },

  // ─── Wordy phrases ──────────────────────────────────────────────────────────
  {
    id: "wordy",
    check(text) {
      const findings = [];
      const wordyPhrases = {
        "at this point in time": "now",
        "due to the fact that": "because",
        "in order to": "to",
        "in the event that": "if",
        "in spite of the fact that": "although",
        "on account of": "because",
        "with the exception of": "except",
        "for the purpose of": "to",
        "in the near future": "soon",
        "at the present time": "now",
        "it is important to note that": "",
        "it should be noted that": "",
        "the fact that": "",
        "in close proximity to": "near",
        "a large number of": "many",
        "a small number of": "few",
        "in light of the fact": "because",
        "make a decision": "decide",
        "come to a conclusion": "conclude",
        "take into consideration": "consider",
        "in my personal opinion": "in my opinion",
        "absolutely certain": "certain",
        "past history": "history",
        "end result": "result",
        "future plans": "plans",
        "completely eliminate": "eliminate",
        "added bonus": "bonus",
        "unexpected surprise": "surprise",
      };
      for (const [phrase, suggestion] of Object.entries(wordyPhrases)) {
        const re = new RegExp(`\\b${phrase.replace(/\s+/g, "\\s+")}\\b`, "gi");
        let m;
        while ((m = re.exec(text)) !== null) {
          const sug = suggestion ? `"${suggestion}"` : "(remove it entirely)";
          findings.push({
            index: m.index,
            length: m[0].length,
            type: "wordy",
            severity: "info",
            label: "Wordy phrase",
            message: `"${m[0]}" is wordy.`,
            explanation:
              "Concise writing is stronger. Long, filler phrases can be replaced with shorter equivalents without losing meaning.",
            example: `❌  "${phrase}"\n✅  ${sug}`,
            fix: `Replace "${phrase}" with ${sug}.`,
          });
        }
      }
      return findings;
    },
  },

  // ─── Affect vs Effect ────────────────────────────────────────────────────────
  {
    id: "affect-effect",
    check(text) {
      const findings = [];
      // "effect" used as verb
      const reEffectVerb = /\b(effect(?:s|ed|ing)?)\s+(?:the|a|an|my|your|his|her|its|our|their|this|that)\b/gi;
      let m;
      while ((m = reEffectVerb.exec(text)) !== null) {
        findings.push({
          index: m.index,
          length: m[1].length,
          type: "affect-effect",
          severity: "warning",
          label: "affect vs effect",
          message: `"${m[1]}" might be wrong here — did you mean "affect"?`,
          explanation:
            '"Affect" is almost always a verb (to influence something). "Effect" is almost always a noun (the result). "Effect" as a verb is rare and means "to bring about."',
          example:
            '❌  The rain effected our plans.\n✅  The rain affected our plans.\n✅  The rain had an effect on our plans.',
          fix: 'If you mean "to influence," use "affect." If you mean "the result," use "effect."',
        });
      }
      // "affect" used as noun
      const reAffectNoun = /\bthe\s+affect\s+of\b/gi;
      while ((m = reAffectNoun.exec(text)) !== null) {
        findings.push({
          index: m.index + 4,
          length: 6,
          type: "affect-effect",
          severity: "warning",
          label: "affect vs effect",
          message: '"affect" here should probably be "effect" (noun).',
          explanation:
            '"Effect" is the noun form meaning result or outcome. "Affect" as a noun is a psychology term for emotional state.',
          example:
            '❌  the affect of the medicine\n✅  the effect of the medicine',
          fix: 'Replace "affect" with "effect."',
        });
      }
      return findings;
    },
  },

  // ─── Lay vs Lie ──────────────────────────────────────────────────────────────
  {
    id: "lay-lie",
    check(text) {
      const findings = [];
      // "lay" (transitive) used as intransitive
      const reLay = /\b(I|he|she|it|we|they)\s+(layed|lays|is\s+laying|was\s+laying|are\s+laying|were\s+laying)\s+(?:down|there|here|on|in|at|asleep|still|quiet)\b/gi;
      let m;
      while ((m = reLay.exec(text)) !== null) {
        findings.push({
          index: m.index,
          length: m[0].length,
          type: "lay-lie",
          severity: "warning",
          label: "lay vs lie",
          message: `"${m[2]}" may be wrong here — did you mean a form of "lie"?`,
          explanation:
            '"Lie" (lay, lain) is intransitive — the subject rests. "Lay" (laid, laid) is transitive — you lay an object down. This is one of the most commonly confused pairs in English.',
          example:
            '❌  I\'m going to lay down.\n✅  I\'m going to lie down.\n✅  Lay the book on the table.',
          fix: 'Use "lie" when no object follows. Use "lay" when you put something somewhere.',
        });
      }
      return findings;
    },
  },

  // ─── Who vs Whom ─────────────────────────────────────────────────────────────
  {
    id: "who-whom",
    check(text) {
      const findings = [];
      // "who" after a preposition
      const reWhom = /\b(to|for|with|of|by|from|about|at|on|in|through|without|between|among|around)\s+who\b/gi;
      let m;
      while ((m = reWhom.exec(text)) !== null) {
        const start = m.index + m[1].length + 1;
        findings.push({
          index: start,
          length: 3,
          type: "who-whom",
          severity: "warning",
          label: "who vs whom",
          message: `After "${m[1]}," use "whom" not "who."`,
          explanation:
            '"Who" is a subject pronoun (like "he"). "Whom" is an object pronoun (like "him"). After a preposition, always use "whom." Test: replace with he/him — if "him" fits, use "whom."',
          example:
            '❌  To who did you send it?\n✅  To whom did you send it?\n   (You sent it to him → him → whom)',
          fix: 'Replace "who" with "whom."',
        });
      }
      return findings;
    },
  },

  // ─── Fewer vs Less ───────────────────────────────────────────────────────────
  {
    id: "fewer-less",
    check(text) {
      const findings = [];
      const countableNouns = [
        "people", "items", "words", "sentences", "books", "cars", "dogs",
        "cats", "students", "employees", "errors", "mistakes", "problems",
        "issues", "pages", "steps", "points", "calories", "grams", "pounds",
        "miles", "kilometers", "hours", "minutes", "days", "weeks", "months",
        "years", "dollars", "cents", "votes", "seats", "rooms", "doors",
        "windows", "boxes", "bags", "bottles", "cups", "plates", "chairs",
        "tables", "floors", "options", "choices", "questions", "answers",
        "letters", "numbers", "files", "folders", "images", "videos",
        "songs", "movies", "shows", "games", "players", "teams",
      ];
      const re = new RegExp(
        `\\bless\\s+(${countableNouns.join("|")})\\b`,
        "gi"
      );
      let m;
      while ((m = re.exec(text)) !== null) {
        findings.push({
          index: m.index,
          length: 4,
          type: "fewer-less",
          severity: "warning",
          label: "fewer vs less",
          message: `Use "fewer" with countable nouns like "${m[1]}", not "less."`,
          explanation:
            '"Fewer" is for things you can count (fewer apples, fewer people). "Less" is for uncountable amounts (less water, less time). A quick test: can you say "one ___"? If yes, use "fewer."',
          example:
            `❌  less ${m[1]}\n✅  fewer ${m[1]}\n✅  less water (uncountable)`,
          fix: `Replace "less" with "fewer" before "${m[1]}."`,
        });
      }
      return findings;
    },
  },
];

// Very rough verb heuristic (has a word that could be a verb)
function hasVerb(text) {
  return /\b(is|are|was|were|have|has|had|do|does|did|will|would|can|could|shall|should|may|might|must|be|been|being|\w+s|\w+ed|\w+ing)\b/i.test(text);
}

// Export for content.js
if (typeof module !== "undefined") {
  module.exports = RULES;
}
