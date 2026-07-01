// Gramr content script — injected into every page

(function () {
  "use strict";

  // ─── State ──────────────────────────────────────────────────────────────────
  let enabled = true;
  let activeTooltip = null;
  let highlightContainer = null;
  let currentInput = null;
  let debounceTimer = null;
  let findings = [];
  let sessionStats = { errors: 0, warnings: 0, info: 0, seen: new Set() };

  // ─── Settings ────────────────────────────────────────────────────────────────
  const DEBOUNCE_MS = 800;
  const SEVERITY_COLORS = {
    error: "#ef4444",
    warning: "#f59e0b",
    info: "#3b82f6",
  };

  // ─── Init ─────────────────────────────────────────────────────────────────────
  chrome.storage.sync.get({ enabled: true }, (res) => {
    enabled = res.enabled;
    if (enabled) attachListeners();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      enabled = changes.enabled.newValue;
      if (!enabled) {
        removeAllHighlights();
        closeTooltip();
      } else {
        attachListeners();
      }
    }
  });

  function attachListeners() {
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("click", onDocClick, true);
  }

  // ─── Focus / blur ────────────────────────────────────────────────────────────
  function onFocusIn(e) {
    const el = e.target;
    if (!isEditable(el)) return;
    currentInput = el;
    el.addEventListener("input", onInput);
    // Run immediately on focus so existing text is checked
    scheduleCheck(el);
  }

  function onFocusOut(e) {
    if (e.target === currentInput) {
      clearTimeout(debounceTimer);
      // Keep highlights visible after blur
    }
  }

  function onInput(e) {
    scheduleCheck(e.target);
  }

  function onDocClick(e) {
    if (activeTooltip && !activeTooltip.contains(e.target)) {
      closeTooltip();
    }
  }

  // ─── Text extraction ─────────────────────────────────────────────────────────
  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      return ["text", "search", "email", "url", "tel", "password", ""].includes(t);
    }
    if (el.tagName === "TEXTAREA") return true;
    return false;
  }

  function getText(el) {
    if (el.isContentEditable) return el.innerText || "";
    return el.value || "";
  }

  // ─── Analysis ────────────────────────────────────────────────────────────────
  function scheduleCheck(el) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runCheck(el), DEBOUNCE_MS);
  }

  function runCheck(el) {
    if (!enabled) return;
    const text = getText(el);
    if (!text.trim()) {
      removeAllHighlights();
      return;
    }
    findings = [];
    for (const rule of RULES) {
      try {
        const ruleFindings = rule.check(text);
        findings.push(...ruleFindings);
      } catch (_) {}
    }
    // Deduplicate by position
    const seen = new Set();
    findings = findings.filter((f) => {
      const key = `${f.index}:${f.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Update stats
    for (const f of findings) {
      if (!sessionStats.seen.has(`${f.index}:${f.type}:${text.slice(f.index, f.index + f.length)}`)) {
        sessionStats[f.severity] = (sessionStats[f.severity] || 0) + 1;
        sessionStats.seen.add(`${f.index}:${f.type}:${text.slice(f.index, f.index + f.length)}`);
      }
    }
    // Broadcast stats to popup
    chrome.runtime.sendMessage({
      type: "stats",
      stats: {
        errors: sessionStats.errors,
        warnings: sessionStats.warnings,
        info: sessionStats.info,
        total: findings.length,
      },
    }).catch(() => {});

    renderHighlights(el, text, findings);
  }

  // ─── Highlight rendering ──────────────────────────────────────────────────────
  function removeAllHighlights() {
    if (highlightContainer) {
      highlightContainer.remove();
      highlightContainer = null;
    }
    closeTooltip();
  }

  function renderHighlights(el, text, allFindings) {
    removeAllHighlights();
    if (!allFindings.length) return;

    // Only underline for textarea / input (contenteditable is harder to overlay)
    if (!el.isContentEditable && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
      renderInputHighlights(el, text, allFindings);
    } else if (el.isContentEditable) {
      renderContentEditableHighlights(el, allFindings);
    }
  }

  function renderInputHighlights(el, text, allFindings) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const style = window.getComputedStyle(el);

    // Create an invisible mirror div to measure character positions
    const mirror = document.createElement("div");
    const mirrorStyle = {
      position: "absolute",
      top: "-9999px",
      left: "-9999px",
      width: rect.width + "px",
      height: "auto",
      padding: style.padding,
      border: style.border,
      fontSize: style.fontSize,
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      wordSpacing: style.wordSpacing,
      whiteSpace: el.tagName === "TEXTAREA" ? "pre-wrap" : "pre",
      wordWrap: el.tagName === "TEXTAREA" ? "break-word" : "normal",
      overflowWrap: style.overflowWrap,
      boxSizing: "border-box",
      tabSize: style.tabSize,
    };
    Object.assign(mirror.style, mirrorStyle);
    document.body.appendChild(mirror);

    // SVG overlay
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    Object.assign(svg.style, {
      position: "fixed",
      top: rect.top + window.scrollY + "px",
      left: rect.left + window.scrollX + "px",
      width: rect.width + "px",
      height: rect.height + "px",
      pointerEvents: "none",
      zIndex: "2147483640",
      overflow: "hidden",
    });
    svg.style.top = rect.top + "px";
    svg.style.left = rect.left + "px";
    svg.style.position = "fixed";

    // We use clickable spans on top of the SVG for interactivity
    highlightContainer = document.createElement("div");
    Object.assign(highlightContainer.style, {
      position: "fixed",
      top: rect.top + "px",
      left: rect.left + "px",
      width: rect.width + "px",
      height: rect.height + "px",
      pointerEvents: "none",
      zIndex: "2147483641",
      overflow: "hidden",
    });
    highlightContainer.dataset.gramrContainer = "1";
    document.body.appendChild(svg);
    document.body.appendChild(highlightContainer);

    const scrollTop = el.scrollTop;
    const scrollLeft = el.scrollLeft;
    const paddingLeft = parseFloat(style.paddingLeft);
    const paddingTop = parseFloat(style.paddingTop);

    for (const finding of allFindings) {
      const color = SEVERITY_COLORS[finding.severity] || "#6b7280";

      // Measure position using mirror
      mirror.textContent = text.slice(0, finding.index);
      const spanBefore = document.createElement("span");
      spanBefore.textContent = text.slice(finding.index, finding.index + finding.length);
      mirror.appendChild(spanBefore);

      const markerRect = spanBefore.getBoundingClientRect();
      const mirrorRect = mirror.getBoundingClientRect();

      const relTop = markerRect.top - mirrorRect.top + paddingTop - scrollTop;
      const relLeft = markerRect.left - mirrorRect.left + paddingLeft - scrollLeft;
      const w = markerRect.width;
      const lineH = markerRect.height;

      // Wavy underline via SVG
      const y = relTop + lineH - 2;
      if (y < 0 || y > rect.height || relLeft < 0) {
        mirror.textContent = "";
        continue;
      }

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", wavyPath(relLeft, y, w));
      path.setAttribute("stroke", color);
      path.setAttribute("stroke-width", "2");
      path.setAttribute("fill", "none");
      svg.appendChild(path);

      // Invisible click target
      const clickTarget = document.createElement("div");
      Object.assign(clickTarget.style, {
        position: "absolute",
        top: relTop + "px",
        left: relLeft + "px",
        width: Math.max(w, 10) + "px",
        height: lineH + "px",
        cursor: "pointer",
        pointerEvents: "all",
      });
      clickTarget.dataset.findingIndex = allFindings.indexOf(finding);
      clickTarget.addEventListener("click", (e) => {
        e.stopPropagation();
        showTooltip(finding, e.clientX, e.clientY);
      });
      highlightContainer.appendChild(clickTarget);

      mirror.textContent = "";
    }

    mirror.remove();
  }

  function renderContentEditableHighlights(el, allFindings) {
    // For contenteditable, use a simpler approach: show a floating badge
    const rect = el.getBoundingClientRect();
    if (!rect.width) return;

    highlightContainer = document.createElement("div");
    highlightContainer.dataset.gramrContainer = "1";
    Object.assign(highlightContainer.style, {
      position: "fixed",
      top: rect.top + "px",
      left: rect.left + rect.width - 32 + "px",
      zIndex: "2147483641",
      pointerEvents: "all",
    });

    const badge = document.createElement("div");
    badge.className = "gramr-badge";
    badge.textContent = allFindings.length;
    badge.title = `${allFindings.length} suggestion${allFindings.length !== 1 ? "s" : ""}`;
    badge.style.background = allFindings.some((f) => f.severity === "error")
      ? SEVERITY_COLORS.error
      : allFindings.some((f) => f.severity === "warning")
      ? SEVERITY_COLORS.warning
      : SEVERITY_COLORS.info;

    let idx = 0;
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      showTooltip(allFindings[idx % allFindings.length], e.clientX, e.clientY);
      idx++;
    });

    highlightContainer.appendChild(badge);
    document.body.appendChild(highlightContainer);
  }

  function wavyPath(x, y, width) {
    const amp = 2;
    const freq = 6;
    let d = `M ${x} ${y}`;
    for (let i = 0; i <= width; i += freq / 2) {
      const cx1 = x + i;
      const cy1 = y + amp * (i % freq < freq / 2 ? 1 : -1);
      d += ` Q ${cx1} ${cy1} ${x + i + freq / 4} ${y}`;
    }
    return d;
  }

  // ─── Tooltip ──────────────────────────────────────────────────────────────────
  function showTooltip(finding, clientX, clientY) {
    closeTooltip();

    const tip = document.createElement("div");
    tip.className = "gramr-tooltip";

    const severityIcon = { error: "✗", warning: "⚠", info: "ℹ" }[finding.severity] || "•";
    const severityColor = SEVERITY_COLORS[finding.severity];

    tip.innerHTML = `
      <div class="gramr-tip-header" style="border-left-color:${severityColor}">
        <span class="gramr-tip-icon" style="color:${severityColor}">${severityIcon}</span>
        <span class="gramr-tip-label">${escHtml(finding.label)}</span>
        <button class="gramr-tip-close" aria-label="Close">×</button>
      </div>
      <div class="gramr-tip-body">
        <p class="gramr-tip-message">${escHtml(finding.message)}</p>
        <details class="gramr-tip-details" open>
          <summary>Why does this matter?</summary>
          <p>${escHtml(finding.explanation)}</p>
        </details>
        <details class="gramr-tip-details">
          <summary>Examples</summary>
          <pre class="gramr-tip-example">${escHtml(finding.example)}</pre>
        </details>
        <div class="gramr-tip-fix">
          <strong>How to fix:</strong> ${escHtml(finding.fix)}
        </div>
      </div>
    `;

    tip.querySelector(".gramr-tip-close").addEventListener("click", (e) => {
      e.stopPropagation();
      closeTooltip();
    });

    document.body.appendChild(tip);
    activeTooltip = tip;

    // Position: prefer below/right of click, stay in viewport
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tipW = 340;
    const tipH = tip.offsetHeight || 300;

    let left = clientX + 12;
    let top = clientY + 12;

    if (left + tipW > vw - 12) left = clientX - tipW - 12;
    if (left < 12) left = 12;
    if (top + tipH > vh - 12) top = clientY - tipH - 12;
    if (top < 12) top = 12;

    tip.style.left = left + "px";
    tip.style.top = top + "px";

    // Animate in
    requestAnimationFrame(() => tip.classList.add("gramr-tooltip--visible"));
  }

  function closeTooltip() {
    if (activeTooltip) {
      activeTooltip.remove();
      activeTooltip = null;
    }
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ─── Grammar rules ────────────────────────────────────────────────────────────

  function hasVerb(text) {
    return /\b(is|are|was|were|have|has|had|do|does|did|will|would|can|could|shall|should|may|might|must|be|been|being|\w+s|\w+ed|\w+ing)\b/i.test(text);
  }

  // ─── Misspellings dictionary (500+) ─────────────────────────────────────────
  const MISSPELLINGS = {
    // A
    "absense":"absence","accidently":"accidentally","accomodate":"accommodate",
    "acheive":"achieve","accross":"across","adress":"address","adiquate":"adequate",
    "advertisment":"advertisement","agressive":"aggressive","allegience":"allegiance",
    "alotted":"allotted","alot":"a lot","alltogether":"altogether","ambigious":"ambiguous",
    "anaylsis":"analysis","anonimous":"anonymous","antecedant":"antecedent",
    "appearence":"appearance","apropriate":"appropriate","aproximately":"approximately",
    "aquire":"acquire","arguement":"argument","aritmetic":"arithmetic",
    "arrangment":"arrangement","assasination":"assassination","assesment":"assessment",
    "assistanse":"assistance","attendence":"attendance","attitide":"attitude",
    "audiance":"audience","autority":"authority","availible":"available",
    "aukward":"awkward","amature":"amateur","apparant":"apparent",
    // B
    "baloon":"balloon","bankrupcy":"bankruptcy","basicly":"basically",
    "beautifull":"beautiful","beutiful":"beautiful","becuase":"because",
    "becomming":"becoming","begining":"beginning","beggining":"beginning",
    "benificial":"beneficial","benifit":"benefit","beleive":"believe",
    "buisness":"business",
    // C
    "calender":"calendar","catagory":"category","cemetary":"cemetery",
    "celeberate":"celebrate","certian":"certain","challange":"challenge",
    "charcter":"character","cheif":"chief","choclate":"chocolate",
    "cieling":"ceiling","collegue":"colleague","colum":"column",
    "comfortible":"comfortable","comming":"coming","commitee":"committee",
    "committment":"commitment","comunication":"communication",
    "competiton":"competition","completly":"completely","concieve":"conceive",
    "concious":"conscious","consequense":"consequence","consistant":"consistent",
    "continueing":"continuing","conveniance":"convenience","convienence":"convenience",
    "counterfiet":"counterfeit","courtous":"courteous","critisism":"criticism",
    "curiousity":"curiosity","curriculem":"curriculum",
    // D
    "decieve":"deceive","decisoin":"decision","definate":"definite",
    "definately":"definitely","democrasy":"democracy","desparate":"desperate",
    "developement":"development","differnce":"difference","dilema":"dilemma",
    "disapoint":"disappoint","disasterous":"disastrous","discription":"description",
    "discribe":"describe","dissapear":"disappear","dissappoint":"disappoint",
    "distanse":"distance","divison":"division","dominat":"dominant",
    // E
    "easly":"easily","elimentary":"elementary","ellaborate":"elaborate",
    "embarass":"embarrass","embarrasment":"embarrassment","encunter":"encounter",
    "enought":"enough","entrepeneur":"entrepreneur","enviroment":"environment",
    "enviromental":"environmental","especialy":"especially","expecially":"especially",
    "essencial":"essential","exagerate":"exaggerate","excellant":"excellent",
    "excercise":"exercise","exersize":"exercise","exaust":"exhaust",
    "existance":"existence","experiance":"experience","explaination":"explanation",
    "extrodinary":"extraordinary","electorial":"electoral","eligable":"eligible",
    // F
    "familier":"familiar","facinating":"fascinating","Febuary":"February",
    "ficticious":"fictitious","finaly":"finally","flourescent":"fluorescent",
    "foriegn":"foreign","fourty":"forty","foward":"forward","freind":"friend",
    "fullfill":"fulfill",
    // G
    "generaly":"generally","genuis":"genius","genuiene":"genuine",
    "glamourous":"glamorous","goverment":"government","grammer":"grammar",
    "greatful":"grateful","guarentee":"guarantee","gaurd":"guard",
    "guidanse":"guidance",
    // H
    "hankerchief":"handkerchief","happend":"happened","hight":"height",
    "heros":"heroes","hopefull":"hopeful","humerous":"humorous","hygeine":"hygiene",
    "heirarchy":"hierarchy","hypocracy":"hypocrisy",
    // I
    "ignorence":"ignorance","imagenary":"imaginary","immitate":"imitate",
    "imediate":"immediate","immediatly":"immediately","importent":"important",
    "independant":"independent","indispensible":"indispensable",
    "influense":"influence","ingrediant":"ingredient","inteligence":"intelligence",
    "intresting":"interesting","interupt":"interrupt","iland":"island",
    "incidently":"incidentally","irrelevent":"irrelevant",
    // J
    "jelous":"jealous","jewlery":"jewelry",
    // K
    "knowlege":"knowledge","nowledge":"knowledge",
    // L
    "langauge":"language","liesure":"leisure","lenght":"length",
    "libary":"library","liberry":"library","lisence":"license",
    "lightening":"lightning","liason":"liaison","loveable":"lovable",
    // M
    "mariage":"marriage","mathmatics":"mathematics","medecine":"medicine",
    "medeval":"medieval","minimun":"minimum","miscelaneous":"miscellaneous",
    "mischievious":"mischievous","mispell":"misspell","momento":"memento",
    "morgage":"mortgage","mucsle":"muscle","manuever":"maneuver",
    "maintanance":"maintenance","millenium":"millennium","miniscule":"minuscule",
    // N
    "naieve":"naive","naturaly":"naturally","neccessary":"necessary",
    "neice":"niece","nervious":"nervous","neverthless":"nevertheless",
    "nickle":"nickel","ninty":"ninety","noticable":"noticeable",
    // O
    "ocasionally":"occasionally","ocassionally":"occasionally",
    "occurance":"occurrence","occured":"occurred","offical":"official",
    "omision":"omission","ommit":"omit","oportunity":"opportunity",
    "oposition":"opposition","ordenary":"ordinary","orignal":"original",
    "outragous":"outrageous",
    // P
    "pamflet":"pamphlet","parallell":"parallel","paralel":"parallel",
    "parliment":"parliament","particuarly":"particularly","passtime":"pastime",
    "patiance":"patience","peculier":"peculiar","peice":"piece",
    "percieve":"perceive","permanant":"permanent","permited":"permitted",
    "perseverence":"perseverance","phenominon":"phenomenon",
    "physican":"physician","plagarism":"plagiarism","plausable":"plausible",
    "playright":"playwright","pleasent":"pleasant","posession":"possession",
    "posible":"possible","postion":"position","practicle":"practical",
    "preceed":"precede","prefered":"preferred","preperation":"preparation",
    "presense":"presence","prevailent":"prevalent","principel":"principle",
    "privelege":"privilege","priviledge":"privilege","probly":"probably",
    "problam":"problem","profesional":"professional","professer":"professor",
    "prominant":"prominent","pronounciation":"pronunciation","propoganda":"propaganda",
    "pursuade":"persuade","persue":"pursue","persistant":"persistent",
    "publically":"publicly",
    // Q
    "quanity":"quantity","quarentine":"quarantine","questionaire":"questionnaire",
    // R
    "rediculous":"ridiculous","recomend":"recommend","recomendation":"recommendation",
    "recieve":"receive","referance":"reference","rehersal":"rehearsal",
    "releive":"relieve","relavant":"relevant","relevent":"relevant",
    "religous":"religious","reluctent":"reluctant","repitition":"repetition",
    "resistence":"resistance","rescent":"recent","resturant":"restaurant",
    "restaraunt":"restaurant","roomate":"roommate","routeen":"routine",
    "rythm":"rhythm",
    // S
    "sallary":"salary","schedual":"schedule","sissors":"scissors",
    "sisors":"scissors","secratary":"secretary","sensable":"sensible",
    "sentance":"sentence","seperate":"separate","sargent":"sergeant",
    "similer":"similar","sincerly":"sincerely","sophmore":"sophomore",
    "specail":"special","specefic":"specific","speach":"speech",
    "stomack":"stomach","strenght":"strength","studing":"studying",
    "succede":"succeed","sucess":"success","suficient":"sufficient",
    "supercede":"supersede","superscede":"supersede","suprise":"surprise",
    "suspicous":"suspicious","symetry":"symmetry",
    // T
    "tatoo":"tattoo","technicle":"technical","technolgy":"technology",
    "temperture":"temperature","tendancy":"tendency","therefor":"therefore",
    "thoroough":"thorough","throuh":"through","tommorrow":"tomorrow",
    "tommorow":"tomorrow","tounge":"tongue","tounament":"tournament",
    "tradgedy":"tragedy","transfered":"transferred","treshhold":"threshold",
    "totaly":"totally","trully":"truly","truely":"truly","tyrany":"tyranny",
    "tyranical":"tyrannical",
    // U
    "unfortunatley":"unfortunately","unnecessery":"unnecessary","untill":"until",
    "usualy":"usually","usefull":"useful",
    // V
    "vaccuum":"vacuum","valueable":"valuable","vegatable":"vegetable",
    "vengence":"vengeance","visable":"visible","visability":"visibility",
    "volunter":"volunteer","vunerable":"vulnerable",
    // W
    "Wendsday":"Wednesday","Wensday":"Wednesday","wieght":"weight",
    "wierd":"weird","wether":"whether","wich":"which","writting":"writing",
    // Y
    "yatch":"yacht","yeild":"yield",
    // Additional entries to reach 500+
    // A (more)
    "absense":"absence","accidentaly":"accidentally","acomodate":"accommodate",
    "adaquate":"adequate","aggrieve":"aggrieve","agravate":"aggravate",
    "agreable":"agreeable","alledge":"allege","allready":"already",
    "allways":"always","almoust":"almost","alot":"a lot","altough":"although",
    "analagous":"analogous","anual":"annual","apologise":"apologize",
    "appal":"appall","aquaintance":"acquaintance","archetect":"architect",
    "artefact":"artifact","assit":"assist","atribute":"attribute",
    "awfull":"awful",
    // B (more)
    "barbarian":"barbarian","begginer":"beginner","benivolent":"benevolent",
    "besige":"besiege","bogus":"bogus","boundry":"boundary",
    "briliant":"brilliant","brutaly":"brutally","buget":"budget",
    // C (more)
    "camoflage":"camouflage","capabilty":"capability","carear":"career",
    "carful":"careful","carribean":"Caribbean","cataloge":"catalog",
    "catagories":"categories","centry":"century","certin":"certain",
    "chalenging":"challenging","champain":"champagne","charecter":"character",
    "charming":"charming","circomstance":"circumstance","citezenship":"citizenship",
    "clasify":"classify","colaberative":"collaborative","colaege":"colleague",
    "comision":"commission","comparason":"comparison","compatable":"compatible",
    "compitition":"competition","conceed":"concede","condescendng":"condescending",
    "conected":"connected","consious":"conscious","contibute":"contribute",
    "controvercial":"controversial","convience":"convenience","corect":"correct",
    "councel":"council","crital":"critical","culter":"culture",
    // D (more)
    "dacision":"decision","decipher":"decipher","definiton":"definition",
    "delibrate":"deliberate","dependance":"dependence","desicion":"decision",
    "diferent":"different","disapproval":"disapproval","discepline":"discipline",
    "disscuss":"discuss","distructive":"destructive","divert":"divert",
    "dominence":"dominance","dramaticly":"dramatically","duely":"duly",
    // E (more)
    "effectivly":"effectively","embaressed":"embarrassed","eminant":"eminent",
    "emision":"emission","emporer":"emperor","encourge":"encourage",
    "enormus":"enormous","enthusiasim":"enthusiasm","entrence":"entrance",
    "enviornment":"environment","epidemy":"epidemic","equaly":"equally",
    "equiptment":"equipment","estatic":"ecstatic","evidant":"evident",
    "exactely":"exactly","excede":"exceed","excelerate":"accelerate",
    "exilarate":"exhilarate","expereince":"experience","expession":"expression",
    "extraordinery":"extraordinary",
    // F (more)
    "fameous":"famous","fasinating":"fascinating","favorit":"favorite",
    "firey":"fiery","flexable":"flexible","focuss":"focus",
    "forceful":"forceful","forfit":"forfeit","foriegner":"foreigner",
    "fourm":"forum","frequecy":"frequency","friendley":"friendly",
    "futher":"further",
    // G (more)
    "gastly":"ghastly","generouse":"generous","graceous":"gracious",
    "gradiant":"gradient","gratuitus":"gratuitous","greif":"grief",
    "guidence":"guidance","guily":"guilty",
    // H (more)
    "habitual":"habitual","harasment":"harassment","harrasment":"harassment",
    "headach":"headache","heavaly":"heavily","hierchy":"hierarchy",
    "higharchy":"hierarchy","histiry":"history","horible":"horrible",
    "hostility":"hostility","houraglass":"hourglass",
    // I (more)
    "identiy":"identity","ilustrate":"illustrate","imbalanced":"imbalanced",
    "immoveable":"immovable","impeed":"impede","impliment":"implement",
    "impresive":"impressive","improvment":"improvement","inadaquate":"inadequate",
    "increadible":"incredible","indespensable":"indispensable",
    "indivdual":"individual","infered":"inferred","innappropriate":"inappropriate",
    "inspiraton":"inspiration","instaled":"installed","intrest":"interest",
    "intrduced":"introduced","irresponsible":"irresponsible",
    // J (more)
    "jeopardy":"jeopardy","jouney":"journey","jugment":"judgment",
    // K (more)
    "knowledgeable":"knowledgeable",
    // L (more)
    "labrytinth":"labyrinth","layed":"laid","leagal":"legal",
    "learnng":"learning","legitamate":"legitimate","liitle":"little",
    "limitting":"limiting","logicaly":"logically","lonley":"lonely",
    // M (more)
    "magnifcent":"magnificent","maintian":"maintain","managment":"management",
    "manipualte":"manipulate","manufacter":"manufacturer","marginaly":"marginally",
    "mastermined":"mastermind","medeival":"medieval","memoreable":"memorable",
    "mesage":"message","miliary":"military","milenium":"millennium",
    "mimiking":"mimicking","mispresent":"misrepresent","mistakenly":"mistakenly",
    "modefied":"modified","momentaraly":"momentarily","monestary":"monastery",
    "monkies":"monkeys","monotonous":"monotonous","moraly":"morally",
    "motovation":"motivation","mountian":"mountain","mulitple":"multiple",
    // N (more)
    "narative":"narrative","negotation":"negotiation","neibourhood":"neighborhood",
    "neightbour":"neighbor","niether":"neither","nominate":"nominate",
    "noteable":"notable","noticeble":"noticeable","nusance":"nuisance",
    // O (more)
    "objection":"objection","observaton":"observation","obsticle":"obstacle",
    "ocasion":"occasion","ommision":"omission","operaton":"operation",
    "opponant":"opponent","opressive":"oppressive","orginal":"original",
    "organsation":"organisation","orignally":"originally",
    // P (more)
    "pacifist":"pacifist","painfull":"painful","palce":"palace",
    "papaer":"paper","pasenger":"passenger","peaceble":"peaceable",
    "penultimte":"penultimate","performence":"performance","physcial":"physical",
    "picutre":"picture","polotical":"political","posession":"possession",
    "possiblity":"possibility","potentail":"potential","powerfull":"powerful",
    "pratically":"practically","precisley":"precisely","predicament":"predicament",
    "premiss":"premise","prevous":"previous","principaly":"principally",
    "probelem":"problem","professer":"professor","progres":"progress",
    "projetc":"project","promonent":"prominent","provied":"provided",
    "pshycology":"psychology","pubilc":"public","purposly":"purposely",
    // Q (more)
    "qualety":"quality","qucik":"quick","questionare":"questionnaire",
    // R (more)
    "realise":"realize","reaserch":"research","reccomend":"recommend",
    "recieve":"receive","recognse":"recognise","recomendation":"recommendation",
    "redicule":"ridicule","refrendum":"referendum","regualar":"regular",
    "relivent":"relevant","remembrance":"remembrance","renoun":"renown",
    "reoccur":"recur","resevoir":"reservoir","resposiblity":"responsibility",
    "retreive":"retrieve","reverence":"reverence","ridiculus":"ridiculous",
    "rigourous":"rigorous",
    // S (more)
    "sacrafice":"sacrifice","saftey":"safety","sargeant":"sergeant",
    "scenary":"scenery","sceince":"science","scisors":"scissors",
    "seige":"siege","sentance":"sentence","sepperate":"separate",
    "siez":"seize","signifcant":"significant","sincerely":"sincerely",
    "slaught":"slaughter","soluton":"solution","somthing":"something",
    "sophmoric":"sophomoric","spefically":"specifically","sponcered":"sponsored",
    "staight":"straight","stament":"statement","steriotype":"stereotype",
    "stratagy":"strategy","strucure":"structure","stubbern":"stubborn",
    "subjectve":"subjective","sumon":"summon","suplied":"supplied",
    "surreptiously":"surreptitiously","suceeded":"succeeded",
    // T (more)
    "tanamount":"tantamount","techincal":"technical","tenatious":"tenacious",
    "therom":"theorem","thoughtfull":"thoughtful","threshhold":"threshold",
    "togather":"together","tollerance":"tolerance","tomorrrow":"tomorrow",
    "tomorow":"tomorrow","torturous":"torturous","totatly":"totally",
    "tradional":"traditional","trancript":"transcript","transfering":"transferring",
    "tremandous":"tremendous","truely":"truly","tubercolosis":"tuberculosis",
    "twelvth":"twelfth","tyranical":"tyrannical",
    // U (more)
    "unbeleivable":"unbelievable","underlining":"underlying","undesireable":"undesirable",
    "unfortuanately":"unfortunately","uninamous":"unanimous","univeristy":"university",
    "unkown":"unknown","unpresedented":"unprecedented","unreliabe":"unreliable",
    "uterly":"utterly",
    // V (more)
    "vacum":"vacuum","vaguley":"vaguely","vandelism":"vandalism",
    "variuos":"various","vegtable":"vegetable","verbosly":"verbosely",
    "verteran":"veteran","vigourous":"vigorous","villan":"villain",
    "vincible":"vincible","voilate":"violate","voltaire":"Voltaire",
    "vunreable":"vulnerable",
    // W (more)
    "warrent":"warrant","welath":"wealth","wellfare":"welfare",
    "wepon":"weapon","whith":"with","withold":"withhold",
    "wonderfull":"wonderful","worreid":"worried","worthwile":"worthwhile",
    "woudl":"would",
    // Z (more)
    "zealos":"zealous","zenophobia":"xenophobia",
  };

  const MISSPELLING_RE = new RegExp(
    `\\b(${Object.keys(MISSPELLINGS).join("|")})\\b`, "gi"
  );

  const RULES = [
    {
      id: "comma-splice",
      check(text) {
        const findings = [];
        const re = /([A-Z][^.!?]*[a-z]),\s+([A-Z][^.!?]*[a-z])/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          if (hasVerb(m[1]) && hasVerb(m[2])) {
            findings.push({
              index: m.index + m[1].length,
              length: 1,
              type: "comma-splice",
              severity: "warning",
              label: "Comma splice",
              message: "A comma is joining two complete sentences here.",
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
    {
      id: "oxford-comma",
      check(text) {
        const findings = [];
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
              'Conjunctive adverbs like "however," "therefore," and "furthermore" need a comma after them when they appear at the start of a sentence.',
            example: `❌  However I disagree.\n✅  However, I disagree.`,
            fix: `Add a comma after "${word}".`,
          });
        }
        return findings;
      },
    },
    {
      id: "its-its",
      check(text) {
        const findings = [];
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
              '"it\'s" is a contraction of "it is" or "it has." "its" (no apostrophe) is the possessive form.',
            example:
              '❌  The dog wagged it\'s tail.\n✅  The dog wagged its tail.',
            fix: 'Replace "it\'s" with "its."',
          });
        }
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
              '❌  Its going to rain.\n✅  It\'s going to rain.',
            fix: 'Replace "its" with "it\'s."',
          });
        }
        return findings;
      },
    },
    {
      id: "there-their-theyre",
      check(text) {
        const findings = [];
        const reTheirThere = /\b(is|are|was|were|over|out|down|up|back|right|left|away)\s+their\b/gi;
        let m;
        while ((m = reTheirThere.exec(text)) !== null) {
          findings.push({
            index: m.index + m[1].length + 1,
            length: 5,
            type: "there-their-theyre",
            severity: "error",
            label: "their / there / they're",
            message: `"their" may be wrong here — did you mean "there"?`,
            explanation:
              '"there" refers to a place or introduces a sentence. "their" shows possession. "they\'re" = they are.',
            example:
              '❌  Is their a problem?\n✅  Is there a problem?',
            fix: 'Use "there" to refer to a place.',
          });
        }
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
              '"their" shows possession. "there" refers to a place.',
            example:
              '❌  I like there house.\n✅  I like their house.',
            fix: 'Replace "there" with "their."',
          });
        }
        return findings;
      },
    },
    {
      id: "your-youre",
      check(text) {
        const findings = [];
        const reYour = /\byour\s+(?:a|an|the|not|going|welcome|right|wrong|sure|ready|done|able|allowed|supposed|trying|kidding|joking|serious|crazy|awesome|amazing|great|terrible|correct|late|early|free|busy|tired|sick|excited|happy|sad|angry|nervous|lucky|smart|funny)\b/gi;
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
              '"you\'re" = "you are." "your" is possessive.',
            example:
              '❌  Your going to love this.\n✅  You\'re going to love this.',
            fix: 'Replace "your" with "you\'re."',
          });
        }
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
              "In standard written English, two negative words cancel each other out, resulting in a positive meaning.",
            example:
              "❌  I don't know nothing. (= I know something)\n✅  I don't know anything.\n✅  I know nothing.",
            fix: "Replace one of the negatives with its positive equivalent.",
          });
        }
        return findings;
      },
    },
    {
      id: "affect-effect",
      check(text) {
        const findings = [];
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
              '"Affect" is almost always a verb. "Effect" is almost always a noun.',
            example:
              '❌  The rain effected our plans.\n✅  The rain affected our plans.\n✅  The rain had an effect on our plans.',
            fix: 'If you mean "to influence," use "affect." If you mean "the result," use "effect."',
          });
        }
        const reAffectNoun = /\bthe\s+affect\s+of\b/gi;
        while ((m = reAffectNoun.exec(text)) !== null) {
          findings.push({
            index: m.index + 4,
            length: 6,
            type: "affect-effect",
            severity: "warning",
            label: "affect vs effect",
            message: '"affect" here should probably be "effect" (noun).',
            explanation: '"Effect" is the noun form meaning result or outcome.',
            example:
              '❌  the affect of the medicine\n✅  the effect of the medicine',
            fix: 'Replace "affect" with "effect."',
          });
        }
        return findings;
      },
    },
    {
      id: "who-whom",
      check(text) {
        const findings = [];
        const reWhom = /\b(to|for|with|of|by|from|about|at|on|in|through|without|between|among|around)\s+who\b/gi;
        let m;
        while ((m = reWhom.exec(text)) !== null) {
          findings.push({
            index: m.index + m[1].length + 1,
            length: 3,
            type: "who-whom",
            severity: "warning",
            label: "who vs whom",
            message: `After "${m[1]}," use "whom" not "who."`,
            explanation:
              '"Who" is a subject pronoun (like "he"). "Whom" is an object pronoun (like "him"). After a preposition, always use "whom."',
            example:
              '❌  To who did you send it?\n✅  To whom did you send it?',
            fix: 'Replace "who" with "whom."',
          });
        }
        return findings;
      },
    },
    {
      id: "fewer-less",
      check(text) {
        const findings = [];
        const countableNouns = [
          "people", "items", "words", "sentences", "books", "cars", "dogs",
          "cats", "students", "employees", "errors", "mistakes", "problems",
          "issues", "pages", "steps", "points", "calories", "grams", "pounds",
          "miles", "hours", "minutes", "days", "weeks", "months", "years",
          "dollars", "votes", "seats", "rooms", "options", "choices",
          "questions", "answers", "letters", "numbers", "files", "games",
        ];
        const re = new RegExp(`\\bless\\s+(${countableNouns.join("|")})\\b`, "gi");
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 4,
            type: "fewer-less",
            severity: "warning",
            label: "fewer vs less",
            message: `Use "fewer" with countable nouns like "${m[1]}".`,
            explanation:
              '"Fewer" is for things you can count. "Less" is for uncountable amounts.',
            example: `❌  less ${m[1]}\n✅  fewer ${m[1]}`,
            fix: `Replace "less" with "fewer" before "${m[1]}."`,
          });
        }
        return findings;
      },
    },
    // ── Wordy phrases ───────────────────────────────────────────────────────
    {
      id: "wordy",
      check(text) {
        const findings = [];
        const wordyPhrases = {
          "at this point in time": "now",
          "at the present time": "now",
          "at the current time": "now",
          "at this moment in time": "now",
          "due to the fact that": "because",
          "in light of the fact that": "because",
          "on account of the fact that": "because",
          "in spite of the fact that": "although",
          "in order to": "to",
          "in order for": "for",
          "in the event that": "if",
          "in the event of": "if",
          "on account of": "because",
          "with the exception of": "except",
          "for the purpose of": "to",
          "for the reason that": "because",
          "in the near future": "soon",
          "in close proximity to": "near",
          "a large number of": "many",
          "a small number of": "few",
          "a majority of": "most",
          "the majority of": "most",
          "make a decision": "decide",
          "make a choice": "choose",
          "make an assumption": "assume",
          "make a determination": "determine",
          "come to a conclusion": "conclude",
          "reach a conclusion": "conclude",
          "come to an agreement": "agree",
          "take into consideration": "consider",
          "take into account": "consider",
          "give consideration to": "consider",
          "in my personal opinion": "in my opinion",
          "in my own personal opinion": "in my opinion",
          "personally, i think": "I think",
          "past history": "history",
          "end result": "result",
          "final outcome": "outcome",
          "future plans": "plans",
          "added bonus": "bonus",
          "unexpected surprise": "surprise",
          "free gift": "gift",
          "true fact": "fact",
          "basic fundamentals": "fundamentals",
          "new innovation": "innovation",
          "advance warning": "warning",
          "first and foremost": "first",
          "each and every": "every",
          "any and all": "all",
          "null and void": "void",
          "cease and desist": "stop",
          "basic necessities": "necessities",
          "completely eliminate": "eliminate",
          "completely destroy": "destroy",
          "successfully completed": "completed",
          "in terms of": "",
          "with regard to": "about",
          "with respect to": "about",
          "in relation to": "about",
          "as a result of": "because of",
          "as a consequence of": "because of",
          "despite the fact that": "although",
          "regardless of the fact that": "although",
          "it is worth noting that": "",
          "it is important to note that": "",
          "it should be noted that": "",
          "needless to say": "",
          "it goes without saying": "",
          "the fact that": "",
          "as a matter of fact": "in fact",
          "in actual fact": "in fact",
          "for all intents and purposes": "practically",
          "to all intents and purposes": "practically",
          "in the final analysis": "finally",
          "at the end of the day": "ultimately",
          "when all is said and done": "ultimately",
        };
        for (const [phrase, suggestion] of Object.entries(wordyPhrases)) {
          const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`, "gi");
          let m;
          while ((m = re.exec(text)) !== null) {
            const sug = suggestion ? `"${suggestion}"` : "remove it";
            findings.push({
              index: m.index,
              length: m[0].length,
              type: "wordy",
              severity: "info",
              label: "Wordy phrase",
              message: `"${m[0]}" is wordy.`,
              explanation:
                "Concise writing is stronger and clearer. Long filler phrases can almost always be replaced with a single word without losing any meaning.",
              example: `❌  "${phrase}"\n✅  ${sug}`,
              fix: suggestion ? `Replace with ${sug}.` : `Remove "${phrase}" — it adds no meaning.`,
            });
          }
        }
        return findings;
      },
    },

    // ── could/would/should of ───────────────────────────────────────────────
    {
      id: "modal-of",
      check(text) {
        const findings = [];
        const re = /\b(could|would|should|must|might|may|ought\s+to\s+have|used\s+to\s+have)\s+of\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          const modal = m[1].replace(/\s+/g, " ");
          findings.push({
            index: m.index,
            length: m[0].length,
            type: "modal-of",
            severity: "error",
            label: `"${modal} of"`,
            message: `"${m[0]}" is not standard — did you mean "${modal} have"?`,
            explanation:
              'The error happens because "could\'ve," "would\'ve," and "should\'ve" sound like "could of" when spoken aloud. But "of" is a preposition, not a verb — "have" is required after modal verbs.',
            example:
              `❌  I ${modal} of done it differently.\n✅  I ${modal} have done it differently.\n✅  I ${modal.replace(/\b(could|would|should|might|may|must)\b/, "$1've")} done it.`,
            fix: `Replace "of" with "have": "${modal} have."`,
          });
        }
        return findings;
      },
    },

    // ── then vs than ────────────────────────────────────────────────────────
    {
      id: "then-than",
      check(text) {
        const findings = [];
        const comparatives = [
          "better","more","less","rather","other","greater","sooner","longer",
          "faster","older","newer","bigger","smaller","higher","lower",
          "stronger","weaker","harder","easier","closer","worse","later",
          "earlier","louder","quieter","heavier","lighter","darker","brighter",
          "hotter","colder","wider","narrower","taller","shorter","deeper",
          "sweeter","richer","poorer","happier","sadder","angrier","busier",
          "further","farther","cheaper","cleaner","smarter","slower",
        ];
        const re = new RegExp(`\\b(${comparatives.join("|")})\\s+then\\b`, "gi");
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index + m[1].length + 1,
            length: 4,
            type: "then-than",
            severity: "error",
            label: "then vs than",
            message: `After a comparative like "${m[1]}", use "than" not "then."`,
            explanation:
              '"Than" is used for comparisons ("bigger than a house"). "Then" refers to time ("first this, then that"). They sound alike but serve completely different purposes.',
            example:
              `❌  She is smarter then him.\n✅  She is smarter than him.\n✅  First study, then relax. (time)`,
            fix: 'Replace "then" with "than."',
          });
        }
        return findings;
      },
    },

    // ── to vs too ───────────────────────────────────────────────────────────
    {
      id: "to-too",
      check(text) {
        const findings = [];
        const adjectives = [
          "much","many","long","short","late","early","far","fast","slow",
          "big","small","loud","quiet","hot","cold","hard","easy","busy",
          "tired","old","young","soon","little","often","heavy","light",
          "dark","bright","high","low","wide","narrow","tall","deep","thick",
          "thin","sweet","rich","poor","happy","sad","angry","serious",
          "expensive","cheap","clean","dirty","safe","dangerous","strong",
          "weak","smart","dumb","close","far","quick","simple","complex",
        ];
        const re = new RegExp(`\\bto\\s+(${adjectives.join("|")})\\b`, "gi");
        let m;
        while ((m = re.exec(text)) !== null) {
          // Skip if preceded by a verb or "go/want/need/have/try" (legitimate "to + adj" constructions are rare)
          const before = text.slice(Math.max(0, m.index - 20), m.index).trim();
          if (/\b(go|want|need|have|try|seem|appear|get|become|turn|grow|come|be|is|are|was|were)\s*$/i.test(before)) continue;
          findings.push({
            index: m.index,
            length: 2,
            type: "to-too",
            severity: "error",
            label: "to vs too",
            message: `"to ${m[1]}" — did you mean "too ${m[1]}"?`,
            explanation:
              '"Too" (with two o\'s) means "excessively" or "also." "To" is a preposition or part of an infinitive. When you mean "excessively," always use "too."',
            example:
              `❌  It is to ${m[1]}.\n✅  It is too ${m[1]}.\n✅  I went to the store. (preposition)`,
            fix: 'Replace "to" with "too."',
          });
        }
        return findings;
      },
    },

    // ── loose vs lose ───────────────────────────────────────────────────────
    {
      id: "loose-lose",
      check(text) {
        const findings = [];
        // "loose" used as a verb (preceded by aux verbs)
        const re = /\b(will|would|could|should|might|may|must|can|can't|won't|don't|didn't|doesn't|never|always|often|sometimes|want\s+to|need\s+to|going\s+to|try\s+to|hate\s+to|afraid\s+to)\s+loose\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index + m[0].length - 5,
            length: 5,
            type: "loose-lose",
            severity: "error",
            label: "loose vs lose",
            message: '"loose" here should be "lose" (to fail to keep or win).',
            explanation:
              '"Lose" (one o) is the verb meaning to misplace something or to be defeated. "Loose" (two o\'s) is an adjective meaning not tight, or a verb meaning to release. They\'re spelled differently and mean different things.',
            example:
              "❌  I always loose my keys.\n✅  I always lose my keys.\n✅  The dog is loose. (adjective — not tight)",
            fix: 'Replace "loose" with "lose."',
          });
        }
        return findings;
      },
    },

    // ── accept vs except ────────────────────────────────────────────────────
    {
      id: "accept-except",
      check(text) {
        const findings = [];
        // "except" used where "accept" is needed
        const reExcept = /\b(I|we|they|he|she|you|please|will|would|can|could|must|should|don't|didn't|won't|wouldn't)\s+except\s+(?:the|this|that|it|them|him|her|your|my|our|their|an?)\b/gi;
        let m;
        while ((m = reExcept.exec(text)) !== null) {
          findings.push({
            index: m.index + m[1].length + 1,
            length: 6,
            type: "accept-except",
            severity: "warning",
            label: "accept vs except",
            message: '"except" here might be "accept" (to receive or agree to).',
            explanation:
              '"Accept" is a verb meaning to receive or agree to something. "Except" is a preposition or conjunction meaning "not including." They sound similar but have very different meanings.',
            example:
              "❌  Please except my apology.\n✅  Please accept my apology.\n✅  Everyone came except John. (not including)",
            fix: 'If you mean "to receive or agree to," use "accept."',
          });
        }
        // "accept" used as "except" (everyone accept X)
        const reAccept = /\b(everyone|everybody|everything|all|anyone|anybody|nothing|no\s+one|nobody)\s+accept\s+(?!for\b)(\w+)/gi;
        while ((m = reAccept.exec(text)) !== null) {
          findings.push({
            index: m.index + m[1].length + 1,
            length: 6,
            type: "accept-except",
            severity: "warning",
            label: "accept vs except",
            message: '"accept" here should likely be "except" (not including).',
            explanation:
              '"Except" means "not including." "Accept" means to receive or agree. When listing exclusions, you need "except."',
            example:
              "❌  Everyone accept John was there.\n✅  Everyone except John was there.",
            fix: 'Replace "accept" with "except."',
          });
        }
        return findings;
      },
    },

    // ── a vs an ─────────────────────────────────────────────────────────────
    {
      id: "a-an",
      check(text) {
        const findings = [];
        // "a" before a vowel sound
        const vowelWords = [
          "apple","orange","elephant","umbrella","oven","ice","ant","hour",
          "honor","honest","heir","error","example","email","idea","issue",
          "offer","open","award","onion","ounce","ocean","action","answer",
          "argument","article","author","event","effort","object","obligation",
          "office","opinion","option","outcome","evidence","experience",
          "examination","explanation","egg","ear","eye","arm","army","angle",
          "apple","area","artist","uncle","upset","account","address","update",
          "upgrade","upload","annual","honest","hour","hourly",
        ];
        const reA = new RegExp(`\\ba\\s+(${vowelWords.join("|")})\\b`, "gi");
        let m;
        while ((m = reA.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 1,
            type: "a-an",
            severity: "error",
            label: "a vs an",
            message: `Use "an" before "${m[1]}" (vowel sound).`,
            explanation:
              'Use "a" before consonant sounds and "an" before vowel sounds. The rule is about the sound, not the letter — "an hour" (silent h, vowel sound) but "a university" (sounds like "yoo").',
            example: `❌  a ${m[1]}\n✅  an ${m[1]}`,
            fix: `Change "a" to "an" before "${m[1]}."`,
          });
        }
        // "an" before a consonant sound
        const consonantWords = [
          "book","car","dog","flower","game","job","kid","letter","man",
          "number","person","race","start","time","vote","war","bag","ball",
          "bank","bird","boy","cake","company","computer","country","cup",
          "day","deal","decision","dream","face","fact","family","field",
          "film","fire","fish","floor","food","force","future","garden",
          "girl","goal","group","hair","hand","head","heart","high","hill",
          "history","home","human","kind","king","knowledge","law","level",
          "life","line","list","look","loss","machine","map","meal","meeting",
          "model","moment","money","month","morning","music","name","need",
          "night","note","pain","paper","park","part","path","peace","plan",
          "point","pool","power","problem","process","product","project",
          "reason","result","road","role","rule","scene","school","season",
          "sign","single","social","song","sort","sound","space","speed",
          "stage","state","step","store","strength","structure","study",
          "summer","support","system","task","team","test","theory","thing",
          "thought","trade","tree","type","view","way","week","window",
          "winter","word","work","world","year","table","chair","house",
          "room","door","street","city","town","building","phone","laptop",
          "computer","tablet","keyboard","mouse","screen","desk",
        ];
        const reAn = new RegExp(`\\ban\\s+(${consonantWords.join("|")})\\b`, "gi");
        while ((m = reAn.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 2,
            type: "a-an",
            severity: "error",
            label: "a vs an",
            message: `Use "a" not "an" before "${m[1]}" (consonant sound).`,
            explanation:
              '"An" is used before vowel sounds. "' + m[1] + '" begins with a consonant sound, so it needs "a."',
            example: `❌  an ${m[1]}\n✅  a ${m[1]}`,
            fix: `Change "an" to "a" before "${m[1]}."`,
          });
        }
        // "an" before words that sound like consonants (u as "yoo")
        const consonantSoundVowelWords = ["university","unicorn","unit","union","unique","user","usual","utility","uniform","European","euphemism","ukulele","usage","uterus"];
        const reAnYoo = new RegExp(`\\ban\\s+(${consonantSoundVowelWords.join("|")})\\b`, "gi");
        while ((m = reAnYoo.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 2,
            type: "a-an",
            severity: "error",
            label: "a vs an",
            message: `Use "a" not "an" before "${m[1]}" — it starts with a "y" sound.`,
            explanation:
              `Although "${m[1]}" starts with the letter U, it is pronounced with a "y" sound (like "you"), which is a consonant sound. So you need "a," not "an."`,
            example: `❌  an ${m[1]}\n✅  a ${m[1]}`,
            fix: `Change "an" to "a" before "${m[1]}."`,
          });
        }
        return findings;
      },
    },

    // ── good vs well ────────────────────────────────────────────────────────
    {
      id: "good-well",
      check(text) {
        const findings = [];
        const re = /\b(am|is|are|was|were)\s+doing\s+good\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index + m[0].length - 4,
            length: 4,
            type: "good-well",
            severity: "warning",
            label: "good vs well",
            message: '"doing good" describing health or performance should be "doing well."',
            explanation:
              '"Good" is an adjective (describes a noun). "Well" is an adverb (describes a verb or describes health). When describing how someone is performing or feeling, use "well." Exception: "doing good" meaning "doing charitable acts" is correct.',
            example:
              '❌  "How are you?" "I am doing good."\n✅  "How are you?" "I am doing well."\n✅  She is doing good work. (adjective modifying "work")',
            fix: 'Replace "good" with "well" when describing performance or health.',
          });
        }
        return findings;
      },
    },

    // ── between/for/with + me/I ──────────────────────────────────────────────
    {
      id: "pronoun-case",
      check(text) {
        const findings = [];
        // "between you and I" → "between you and me"
        const re = /\b(between|for|with|to|from|of|by|about|at|in|on|through|without|among|around|except|besides|including)\s+(?:\w+\s+and\s+I|I\s+and\s+\w+)\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].length,
            type: "pronoun-case",
            severity: "warning",
            label: "Pronoun case",
            message: `After "${m[1]}", use "me" not "I."`,
            explanation:
              'After a preposition (between, for, with, to, etc.), use the object pronoun "me," not the subject pronoun "I." Test: remove the other person — "between I" sounds wrong; "between me" is correct.',
            example:
              '❌  between you and I\n✅  between you and me\n❌  for my friend and I\n✅  for my friend and me',
            fix: 'Replace "I" with "me" after the preposition.',
          });
        }
        return findings;
      },
    },

    // ── complement vs compliment ─────────────────────────────────────────────
    {
      id: "complement-compliment",
      check(text) {
        const findings = [];
        // "complimentary" colors/flavors → "complementary"
        const re1 = /\bcomplimentary\s+(?:colors|colours|flavors|flavours|tones|shades|angles|skills|styles|traits|features)\b/gi;
        let m;
        while ((m = re1.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 13,
            type: "complement-compliment",
            severity: "warning",
            label: "complement vs compliment",
            message: `"complimentary ${m[0].split(" ").slice(1).join(" ")}" should be "complementary."`,
            explanation:
              '"Complement" (with an e) means to complete or go well with something. "Compliment" (with an i) means to praise. Complementary colors complete each other on the color wheel.',
            example:
              "❌  complimentary colors\n✅  complementary colors\n✅  She paid me a compliment. (praise)",
            fix: 'Use "complementary" when meaning "completing or going well with."',
          });
        }
        // "compliment each other" in non-praise sense
        const re2 = /\bcompliment\s+each\s+other\b/gi;
        while ((m = re2.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 10,
            type: "complement-compliment",
            severity: "info",
            label: "complement vs compliment",
            message: '"compliment each other" — did you mean "complement each other"?',
            explanation:
              'If you mean they go well together or complete each other, use "complement." If you mean they say nice things to each other, "compliment" is correct.',
            example:
              "The flavors complement each other. (go well together)\nThey complimented each other. (said nice things)",
            fix: 'Use "complement" if you mean they go well together.',
          });
        }
        return findings;
      },
    },

    // ── principal vs principle ───────────────────────────────────────────────
    {
      id: "principal-principle",
      check(text) {
        const findings = [];
        // "the principle reason/concern/..." → "principal"
        const re = /\bthe\s+principle\s+(reason|concern|goal|objective|cause|role|source|purpose|component|factor|issue|benefit|advantage|difference|focus|aim|challenge|problem|effect|feature|function|agent|investigator|designer|architect|engineer)\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index + 4,
            length: 9,
            type: "principal-principle",
            severity: "warning",
            label: "principal vs principle",
            message: `"the principle ${m[1]}" — did you mean "principal" (main)?`,
            explanation:
              '"Principal" (ends in -al) means main or most important, or refers to a person in charge (school principal). "Principle" (ends in -le) is a rule, belief, or fundamental truth. Memory tip: your principal is your pal.',
            example:
              `❌  the principle reason\n✅  the principal reason (= the main reason)\n✅  a moral principle (= a rule or belief)`,
            fix: 'Use "principal" when you mean "main" or "most important."',
          });
        }
        return findings;
      },
    },

    // ── further vs farther ───────────────────────────────────────────────────
    {
      id: "further-farther",
      check(text) {
        const findings = [];
        // "farther" before abstract nouns → "further"
        const re = /\bfarther\s+(research|discussion|development|investigation|analysis|reading|study|notice|action|delay|information|detail|consideration|review|thought|explanation|context|evidence|work|progress|assistance|help|comment|debate|argument|planning|preparation|training|education|examination|testing|processing|exploration|inquiry|negotiation)\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 7,
            type: "further-farther",
            severity: "info",
            label: "further vs farther",
            message: `"farther ${m[1]}" — for abstract concepts, "further" is preferred.`,
            explanation:
              '"Farther" refers to physical distance ("the store is farther away"). "Further" refers to degree, extent, or metaphorical distance ("further research needed"). Many style guides distinguish them this way.',
            example:
              `❌  farther ${m[1]}\n✅  further ${m[1]}\n✅  The cabin is farther down the road. (physical distance)`,
            fix: 'Use "further" for non-physical extension; "farther" for literal distance.',
          });
        }
        return findings;
      },
    },

    // ── imply vs infer ───────────────────────────────────────────────────────
    {
      id: "imply-infer",
      check(text) {
        const findings = [];
        // "I/you/we infer" used when speaker is implying
        const re = /\b(I|we)\s+(?:can\s+)?implied?\s+(?:that\s+)?(?:from\b|by\b|through\b)/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].length,
            type: "imply-infer",
            severity: "warning",
            label: "imply vs infer",
            message: "The speaker implies; the listener infers.",
            explanation:
              '"Imply" means to hint or suggest something without saying it directly (the speaker does this). "Infer" means to draw a conclusion from evidence (the listener does this). You cannot infer something outward — you imply it.',
            example:
              '❌  I implied from his tone that he was angry.\n✅  I inferred from his tone that he was angry.\n✅  His tone implied he was angry.',
            fix: 'Use "infer" when you are drawing a conclusion from evidence.',
          });
        }
        // "can infer from" where speaker is the source
        const re2 = /\bcan\s+imply\s+from\b/gi;
        while ((m = re2.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].length,
            type: "imply-infer",
            severity: "warning",
            label: "imply vs infer",
            message: '"can imply from" — did you mean "can infer from"?',
            explanation:
              'You infer something from evidence you observe. You imply something by your own words or actions.',
            example:
              '❌  We can imply from this data that…\n✅  We can infer from this data that…',
            fix: 'Replace "imply" with "infer."',
          });
        }
        return findings;
      },
    },

    // ── lay vs lie ───────────────────────────────────────────────────────────
    {
      id: "lay-lie",
      check(text) {
        const findings = [];
        const re = /\b(?:going\s+to|gonna|need\s+to|want\s+to|have\s+to|will|must)\s+lay\s+down\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index + m[0].lastIndexOf("lay"),
            length: 3,
            type: "lay-lie",
            severity: "warning",
            label: "lay vs lie",
            message: '"lay down" here should be "lie down."',
            explanation:
              '"Lie" (intransitive) means to recline — the subject rests. "Lay" (transitive) means to put something down — you lay an object somewhere. "Lay down" is wrong when no object follows. The confusion is made worse by the fact that "lay" is also the past tense of "lie."',
            example:
              "❌  I'm going to lay down.\n✅  I'm going to lie down.\n✅  Lay the book on the table. (object: \"book\")\n✅  I lay down yesterday. (past tense of lie)",
            fix: 'Use "lie down" when talking about reclining yourself.',
          });
        }
        // "I/he/she was laying down" → "was lying down"
        const re2 = /\b(I|he|she|it|we|they|you)\s+(?:was|were|am|is|are)\s+laying\s+down\b/gi;
        while ((m = re2.exec(text)) !== null) {
          findings.push({
            index: m.index + m[0].lastIndexOf("laying"),
            length: 6,
            type: "lay-lie",
            severity: "warning",
            label: "lay vs lie",
            message: '"laying down" here should be "lying down."',
            explanation:
              '"Lying" is the present participle of "lie" (to recline). "Laying" is the present participle of "lay" (to place an object).',
            example:
              "❌  She was laying down on the couch.\n✅  She was lying down on the couch.",
            fix: 'Replace "laying" with "lying."',
          });
        }
        return findings;
      },
    },

    // ── Redundant acronyms ──────────────────────────────────────────────────
    {
      id: "redundant-acronym",
      check(text) {
        const findings = [];
        const pairs = {
          "ATM machine": { full: "Automated Teller Machine", redundant: "machine" },
          "PIN number": { full: "Personal Identification Number", redundant: "number" },
          "HIV virus": { full: "Human Immunodeficiency Virus", redundant: "virus" },
          "LCD display": { full: "Liquid Crystal Display", redundant: "display" },
          "ISBN number": { full: "International Standard Book Number", redundant: "number" },
          "RAM memory": { full: "Random Access Memory", redundant: "memory" },
          "VIN number": { full: "Vehicle Identification Number", redundant: "number" },
          "UPC code": { full: "Universal Product Code", redundant: "code" },
          "SAT test": { full: "Scholastic Assessment Test", redundant: "test" },
          "GPS system": { full: "Global Positioning System", redundant: "system" },
          "PDF format": { full: "Portable Document Format", redundant: "format" },
          "AC current": { full: "Alternating Current", redundant: "current" },
          "DC current": { full: "Direct Current", redundant: "current" },
          "RSVP please": { full: "Répondez s'il vous plaît", redundant: "please" },
          "ABS brakes": { full: "Anti-lock Brake System", redundant: "brakes" },
          "CAD design": { full: "Computer-Aided Design", redundant: "design" },
          "GIF format": { full: "Graphics Interchange Format", redundant: "format" },
          "JPEG format": { full: "Joint Photographic Experts Group", redundant: "format" },
          "WiFi internet": { full: "Wireless Fidelity", redundant: "internet" },
        };
        for (const [phrase, info] of Object.entries(pairs)) {
          const re = new RegExp(`\\b${phrase.replace(/\s+/g, "\\s+")}\\b`, "gi");
          let m;
          while ((m = re.exec(text)) !== null) {
            const acronym = phrase.split(" ")[0];
            findings.push({
              index: m.index,
              length: m[0].length,
              type: "redundant-acronym",
              severity: "info",
              label: "Redundant acronym",
              message: `"${m[0]}" repeats itself — ${acronym} already stands for "${info.full}."`,
              explanation:
                `RAS syndrome (Redundant Acronym Syndrome) occurs when a word in the acronym is repeated after it. "${acronym}" already contains the word "${info.redundant}," so adding it again is redundant.`,
              example: `❌  ${phrase}\n✅  ${acronym} (the "${info.redundant}" is already in the acronym)`,
              fix: `Just write "${acronym}" — drop the extra "${info.redundant}."`,
            });
          }
        }
        return findings;
      },
    },

    // ── Subject–verb agreement ───────────────────────────────────────────────
    {
      id: "subject-verb",
      check(text) {
        const findings = [];
        // Indefinite pronouns that take singular verbs
        const singularSubjects = [
          "everyone","everybody","everything","someone","somebody","something",
          "anyone","anybody","anything","nobody","nothing","each","either",
          "neither","no one",
        ];
        const re = new RegExp(
          `\\b(${singularSubjects.join("|")})\\s+(are|were|have|don't|aren't|weren't|haven't|do)\\b`,
          "gi"
        );
        let m;
        while ((m = re.exec(text)) !== null) {
          const subject = m[1];
          const verb = m[2];
          const correctVerb = {
            "are":"is","were":"was","have":"has","don't":"doesn't",
            "aren't":"isn't","weren't":"wasn't","haven't":"hasn't","do":"does",
          }[verb.toLowerCase()] || verb;
          findings.push({
            index: m.index,
            length: m[0].length,
            type: "subject-verb",
            severity: "warning",
            label: "Subject–verb agreement",
            message: `"${subject}" is singular and takes "${correctVerb}", not "${verb}."`,
            explanation:
              `Indefinite pronouns like "everyone," "somebody," "each," and "neither" are grammatically singular in English, even when they refer to multiple people. They require singular verbs.`,
            example:
              `❌  ${subject} ${verb} ready.\n✅  ${subject} ${correctVerb} ready.`,
            fix: `Replace "${verb}" with "${correctVerb}."`,
          });
        }
        // "The news/mathematics/economics are" → "is"
        const massSingular = ["news","mathematics","physics","economics","statistics","ethics","politics","linguistics","athletics","acoustics","genetics","phonetics"];
        const re2 = new RegExp(`\\b(${massSingular.join("|")})\\s+(are|were)\\b`, "gi");
        while ((m = re2.exec(text)) !== null) {
          const correct = m[2].toLowerCase() === "are" ? "is" : "was";
          findings.push({
            index: m.index,
            length: m[0].length,
            type: "subject-verb",
            severity: "warning",
            label: "Subject–verb agreement",
            message: `"${m[1]}" is treated as singular and takes "${correct}", not "${m[2]}."`,
            explanation:
              `Fields of study and certain nouns ending in -s (like "news," "mathematics," "economics") look plural but are grammatically singular. They always take singular verbs.`,
            example:
              `❌  ${m[1]} ${m[2]} fascinating.\n✅  ${m[1]} ${correct} fascinating.`,
            fix: `Replace "${m[2]}" with "${correct}."`,
          });
        }
        return findings;
      },
    },

    // ── Passive voice (informational) ────────────────────────────────────────
    {
      id: "passive-voice",
      check(text) {
        const findings = [];
        const re = /\b(is|are|was|were|be|been|being)\s+(accomplished|achieved|addressed|affected|allowed|announced|applied|approved|assigned|assumed|avoided|believed|brought|built|called|carried|caused|chosen|claimed|completed|confirmed|considered|created|decided|declared|defined|delivered|designed|determined|developed|distributed|done|driven|established|examined|expected|explained|expressed|found|given|handled|identified|improved|included|indicated|introduced|investigated|issued|known|led|made|managed|measured|noted|obtained|offered|organized|performed|placed|planned|prepared|presented|produced|proposed|provided|published|put|raised|recognized|released|reported|required|resolved|reviewed|said|seen|sent|set|shown|solved|started|studied|submitted|suggested|supported|taken|tested|told|treated|understood|used|viewed|written)\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].length,
            type: "passive-voice",
            severity: "info",
            label: "Passive voice",
            message: `"${m[0]}" is passive voice.`,
            explanation:
              "In passive voice, the subject receives the action rather than performing it. Active voice is usually shorter, clearer, and more engaging. Passive isn't wrong — it's sometimes the right choice — but overuse makes writing feel evasive or dull.",
            example:
              "❌ (passive)  Mistakes were made by the team.\n✅ (active)   The team made mistakes.\n\n(Passive is fine when the actor is unknown or unimportant.)",
            fix: "Ask: who or what is doing the action? Make that the subject.",
          });
        }
        return findings;
      },
    },

    // ── Comma splice ─────────────────────────────────────────────────────────
    {
      id: "comma-splice",
      check(text) {
        const findings = [];
        const re = /([A-Z][^.!?]*[a-z]),\s+([A-Z][^.!?]*[a-z])/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          if (hasVerb(m[1]) && hasVerb(m[2])) {
            findings.push({
              index: m.index + m[1].length,
              length: 1,
              type: "comma-splice",
              severity: "warning",
              label: "Comma splice",
              message: "A comma is joining two complete sentences here.",
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

    // ── Oxford comma ─────────────────────────────────────────────────────────
    {
      id: "oxford-comma",
      check(text) {
        const findings = [];
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

    // ── Intro-clause comma ───────────────────────────────────────────────────
    {
      id: "intro-clause-comma",
      check(text) {
        const findings = [];
        const introWords = [
          "however","therefore","furthermore","moreover","nevertheless",
          "consequently","additionally","meanwhile","otherwise","thus",
          "hence","indeed","instead","similarly","accordingly","subsequently",
          "nonetheless","notwithstanding","conversely","alternatively",
          "incidentally","fortunately","unfortunately","importantly",
          "surprisingly","interestingly","admittedly","certainly","clearly",
          "obviously","undoubtedly","frankly","honestly","briefly",
          "ultimately","finally","initially","specifically","generally",
          "technically","essentially","basically","literally","theoretically",
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
              'Conjunctive adverbs and sentence adverbs like "however," "therefore," "furthermore," and "consequently" need a comma after them when they open a sentence. This signals a pause and clearly separates the transitional word from the main clause.',
            example: `❌  ${word.charAt(0).toUpperCase() + word.slice(1)} I disagree.\n✅  ${word.charAt(0).toUpperCase() + word.slice(1)}, I disagree.`,
            fix: `Add a comma after "${word}".`,
          });
        }
        return findings;
      },
    },

    // ── its vs it's ──────────────────────────────────────────────────────────
    {
      id: "its-its",
      check(text) {
        const findings = [];
        const reContraction = /\bit's\s+(?:own|name|size|color|colour|way|form|place|role|part|turn|job|purpose|effect|shape|design|core|basis|roots|peak|end|start|beginning|strength|weakness|merit|value|worth|price|cost|nature|essence|identity|style|mark|character|appeal|charm|flaw|limit|scope|range|use)\b/gi;
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
              '"it\'s" is always a contraction of "it is" or "it has." "its" (no apostrophe) is the possessive form. Test: read the sentence replacing "it\'s" with "it is" — if it sounds wrong, you want "its."',
            example:
              "❌  The cat licked it's paw.\n✅  The cat licked its paw.\n✅  It's raining. (= It is raining)",
            fix: 'Replace "it\'s" with "its."',
          });
        }
        const reIts = /\bits\s+(?:a|an|the|not|been|going|time|easy|hard|true|false|clear|possible|impossible|okay|ok|fine|great|good|bad|over|done|likely|unlikely|obvious|important|necessary|worth|strange|odd|weird|funny|nice|awful|terrible)\b/gi;
        while ((m = reIts.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 3,
            type: "its-its",
            severity: "error",
            label: "its vs it's",
            message: `"its" here looks like it should be "it's" (it is / it has).`,
            explanation:
              '"it\'s" is a contraction of "it is" or "it has." When you can substitute "it is," use "it\'s." "its" without an apostrophe is possessive only.',
            example:
              "❌  Its going to rain.\n✅  It's going to rain. (= It is going to rain)",
            fix: 'Replace "its" with "it\'s."',
          });
        }
        return findings;
      },
    },

    // ── their / there / they're ─────────────────────────────────────────────
    {
      id: "there-their-theyre",
      check(text) {
        const findings = [];
        const reTheirThere = /\b(is|are|was|were|over|out|down|up|back|right|left|away|goes|went|stands|lives|lies|sits)\s+their\b/gi;
        let m;
        while ((m = reTheirThere.exec(text)) !== null) {
          findings.push({
            index: m.index + m[1].length + 1,
            length: 5,
            type: "there-their-theyre",
            severity: "error",
            label: "their / there / they're",
            message: `"their" after "${m[1]}" — did you mean "there"?`,
            explanation:
              '"there" refers to a place or introduces a clause ("There is…"). "their" is the possessive of "they." "they\'re" = they are. All three sound identical but have completely different functions.',
            example:
              "❌  Is their a problem?\n✅  Is there a problem?\n✅  Their car is blue. (possession)\n✅  They're coming over. (= They are)",
            fix: 'Use "there" to refer to a place or to introduce a clause.',
          });
        }
        const reTherePoss = /\bthere\s+(?:own|house|car|dog|cat|team|school|book|bag|job|idea|plan|group|family|friend|phone|class|room|office|desk|laptop|teacher|boss|child|kid|son|daughter|mom|dad|opinion|decision|choice|problem|fault|mistake|success|failure|goal|dream)\b/gi;
        while ((m = reTherePoss.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 5,
            type: "there-their-theyre",
            severity: "error",
            label: "their / there / they're",
            message: '"there" here should be "their" (possessive).',
            explanation:
              '"their" is the possessive pronoun for "they" — it shows ownership. "there" refers to a place.',
            example:
              "❌  I visited there house.\n✅  I visited their house.",
            fix: 'Replace "there" with "their."',
          });
        }
        return findings;
      },
    },

    // ── your vs you're ───────────────────────────────────────────────────────
    {
      id: "your-youre",
      check(text) {
        const findings = [];
        const reYour = /\byour\s+(?:a|an|the|not|going|welcome|right|wrong|sure|ready|done|able|allowed|supposed|trying|kidding|joking|serious|crazy|awesome|amazing|great|terrible|correct|late|early|free|busy|tired|sick|excited|happy|sad|angry|nervous|lucky|smart|funny|aware|afraid|welcome|mistaken|confused|interested|bored|surprised|shocked|wrong|right|safe|lost|okay|fine|good)\b/gi;
        let m;
        while ((m = reYour.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 4,
            type: "your-youre",
            severity: "error",
            label: "your vs you're",
            message: '"your" here should be "you\'re" (you are).',
            explanation:
              '"you\'re" is a contraction of "you are." "your" is possessive (something belongs to you). Test: replace with "you are" — if it makes sense, use "you\'re."',
            example:
              "❌  Your going to love this.\n✅  You're going to love this.\n✅  Your dog is cute. (possession)",
            fix: 'Replace "your" with "you\'re."',
          });
        }
        const reYoure = /\byou're\s+(?:friend|dog|cat|car|house|phone|bag|book|team|school|job|idea|plan|family|boss|teacher|mom|dad|brother|sister|name|email|number|address|account|password|choice|decision|problem|fault|responsibility|turn|time|money|life|story|opinion|point|question|answer|work|project|assignment|task|goal|dream|success|failure|loss|gain)\b/gi;
        while ((m = reYoure.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 6,
            type: "your-youre",
            severity: "error",
            label: "your vs you're",
            message: '"you\'re" here should be "your" (possessive).',
            explanation:
              '"your" shows possession. "you\'re" = you are. They sound the same but mean completely different things.',
            example:
              "❌  I love you're dog.\n✅  I love your dog.",
            fix: 'Replace "you\'re" with "your."',
          });
        }
        return findings;
      },
    },

    // ── Double negative ──────────────────────────────────────────────────────
    {
      id: "double-negative",
      check(text) {
        const findings = [];
        const re = /\b(can't|cannot|couldn't|don't|doesn't|didn't|won't|wouldn't|shouldn't|haven't|hasn't|hadn't|isn't|aren't|wasn't|weren't|never|no\s+one|nobody)\s+(?:\w+\s+){0,4}(nobody|no\s+one|nothing|nowhere|neither|never|none|no\b)/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].length,
            type: "double-negative",
            severity: "warning",
            label: "Double negative",
            message: "Two negatives create a positive — opposite of what you likely meant.",
            explanation:
              "In standard written English, two negative words cancel each other out, resulting in a positive meaning. Double negatives are natural in some dialects but are avoided in formal writing.",
            example:
              "❌  I don't know nothing. (= I know something)\n✅  I don't know anything.\n✅  I know nothing.",
            fix: "Replace one negative with its positive equivalent.",
          });
        }
        return findings;
      },
    },

    // ── affect vs effect ─────────────────────────────────────────────────────
    {
      id: "affect-effect",
      check(text) {
        const findings = [];
        const reEffectVerb = /\b(effect(?:s|ed|ing)?)\s+(?:the|a|an|my|your|his|her|its|our|their|this|that|these|those|each|every|any|some|no)\b/gi;
        let m;
        while ((m = reEffectVerb.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[1].length,
            type: "affect-effect",
            severity: "warning",
            label: "affect vs effect",
            message: `"${m[1]}" used as a verb — did you mean "affect"?`,
            explanation:
              '"Affect" is almost always a verb (to influence). "Effect" is almost always a noun (the result). "Effect" as a verb is rare and means "to bring about" (e.g., "to effect change").',
            example:
              "❌  The rain effected our plans.\n✅  The rain affected our plans.\n✅  The rain had an effect on our plans.",
            fix: 'Use "affect" if you mean "to influence." Use "effect" for the noun (the result).',
          });
        }
        const reAffectNoun = /\bthe\s+affect\s+of\b/gi;
        while ((m = reAffectNoun.exec(text)) !== null) {
          findings.push({
            index: m.index + 4,
            length: 6,
            type: "affect-effect",
            severity: "warning",
            label: "affect vs effect",
            message: '"the affect of" — did you mean "the effect of"?',
            explanation:
              '"Effect" is the noun. "Affect" as a noun is a psychology term for emotional state — rarely used outside clinical writing.',
            example:
              "❌  the affect of the medicine\n✅  the effect of the medicine",
            fix: 'Replace "affect" with "effect."',
          });
        }
        return findings;
      },
    },

    // ── who vs whom ──────────────────────────────────────────────────────────
    {
      id: "who-whom",
      check(text) {
        const findings = [];
        const re = /\b(to|for|with|of|by|from|about|at|on|in|through|without|between|among|around|after|before|beside|beyond|despite|except|toward|towards|upon|within|against|along|underneath|underneath|regarding|concerning|following|including|excluding)\s+who\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index + m[1].length + 1,
            length: 3,
            type: "who-whom",
            severity: "warning",
            label: "who vs whom",
            message: `After "${m[1]}," use "whom" not "who."`,
            explanation:
              '"Who" is a subject pronoun (like "he/she/they"). "Whom" is an object pronoun (like "him/her/them"). After a preposition, always use the object form "whom." Quick test: substitute "him" — if it fits, use "whom."',
            example:
              "❌  To who did you give it?\n✅  To whom did you give it?\n   (You gave it to him → him = object → whom)",
            fix: 'Replace "who" with "whom."',
          });
        }
        return findings;
      },
    },

    // ── fewer vs less ─────────────────────────────────────────────────────────
    {
      id: "fewer-less",
      check(text) {
        const findings = [];
        const countableNouns = [
          "people","items","words","sentences","books","cars","dogs","cats",
          "students","employees","errors","mistakes","problems","issues","pages",
          "steps","points","calories","grams","pounds","miles","kilometers",
          "hours","minutes","days","weeks","months","years","dollars","cents",
          "votes","seats","rooms","options","choices","questions","answers",
          "letters","numbers","files","folders","games","players","teams",
          "countries","cities","towns","streets","houses","buildings","floors",
          "windows","doors","chairs","tables","cups","plates","bottles","bags",
          "boxes","lines","rows","columns","paragraphs","chapters","sections",
          "articles","posts","comments","emails","messages","calls","texts",
          "photos","images","videos","songs","movies","shows","episodes",
          "seasons","rounds","levels","stages","steps","attempts","trials",
          "tests","exams","assignments","projects","tasks","goals","meetings",
          "appointments","events","concerts","games","matches","races","trips",
          "flights","tickets","passengers","customers","users","members",
          "accounts","reports","documents","forms","applications","requests",
        ];
        const re = new RegExp(`\\bless\\s+(${countableNouns.join("|")})\\b`, "gi");
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
              '"Fewer" is for things you can count individually (fewer apples, fewer people). "Less" is for uncountable quantities (less water, less time, less information). Quick test: can you say "one ___"? If yes, use "fewer."',
            example:
              `❌  less ${m[1]}\n✅  fewer ${m[1]}\n✅  less water (uncountable)`,
            fix: `Replace "less" with "fewer" before "${m[1]}."`,
          });
        }
        return findings;
      },
    },

    // ── Misspellings ─────────────────────────────────────────────────────────
    {
      id: "misspelling",
      check(text) {
        const findings = [];
        let m;
        while ((m = MISSPELLING_RE.exec(text)) !== null) {
          const wrong = m[1].toLowerCase();
          const correct = MISSPELLINGS[wrong];
          if (!correct) continue;
          findings.push({
            index: m.index,
            length: m[1].length,
            type: "misspelling",
            severity: "error",
            label: "Misspelling",
            message: `"${m[1]}" is misspelled.`,
            explanation:
              `"${m[1]}" is a common misspelling. The correct spelling is "${correct}." Misspellings like this often occur because the word sounds different from how it is written, or because a common pattern is incorrectly applied.`,
            example: `❌  ${m[1]}\n✅  ${correct}`,
            fix: `Change "${m[1]}" to "${correct}."`,
          });
        }
        MISSPELLING_RE.lastIndex = 0;
        return findings;
      },
    },
  ];
})();
