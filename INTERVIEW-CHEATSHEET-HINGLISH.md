# 🎯 Funngro Interview Cheatsheet (Hinglish Guide)
**Candidate:** Mayank  
**Role:** Backend Engineer (Node.js / MongoDB) — Funngro (Indore Interview)

Yeh guide specially aapke liye banayi gayi hai taaki aap Loom video recording karte waqt aur Indore in-person interview mein Anik aur Payal ke saamne **100% confidence ke saath har sawal ka jawab fluent Hinglish mein de sakein**.

---

## 📌 Part 1: Code Review & Payout Handler (Interviewer ko kya samjhana hai)

### Sawal 1: "Is code mein sabse dangerous bugs kya the aur tumne unhe kis order mein rank kiya?"

#### 🗣️ Aapka Jawab (Spoken Hinglish):
> *"Sir, Funngro teenagers ka real paisa move karta hai, isliye meri priority financial correctness aur money-safety thi. Maine bugs ko direct financial loss ke hisaab se order kiya hai:*
>
> 1. **Bug #1 (Sabse Dangerous): Gateway call un-awaited tha aur error swallow ho raha tha.**  
>    Code mein `gateway.createPayout()` ke aage `await` nahi tha, aur `catch` block mein sirf `console.log` karke error daba diya gaya tha. Agar bank account galat hai ya gateway 502 de de, toh bhi code Ledger mein entry daal deta hai aur user ko bolta hai 'Success!'. Teenager ka balance kat gaya lekin bank mein paisa nahi gaya. Yeh direct customer trust aur money loss ka issue hai.
>
> 2. **Bug #2: Race Condition & Double-Spend (Non-atomic check-then-act).**  
>    Code pehle `Wallets.findOne` karta hai, fir memory mein `if (balance >= amount)` check karta hai, fir alag se `updateOne` karta hai. Agar teenager app mein jaldi-jaldi double tap kare ya script chalaye, toh do concurrent requests ek sath aayengi. Dono balance ko 1000 dekhengi, dono pass ho jayengi, aur user ₹1000 ke balance se ₹2000 withdraw kar lega! Funngro ko direct financial loss hoga.
>
> 3. **Bug #3: Dynamic Reference (`WD-Date.now()`) with Mobile Retries.**  
>    Mobile app 10s ke timeout pe automatic retry karti hai. Purana code har request pe naya reference banata hai (`Date.now()`). Gateway use nayi transaction samajh ke do baar bank transfer kar dega.
>
> 4. **Bug #4: 40 Million Document Ledger pe bina Index Query aur Memory Sort.**  
>    Write path ke andar `Ledger.find({ userId }).sort({ createdAt: -1 })` chal raha tha. Ledger mein 40M documents hain aur koi index nahi tha. Yeh query database ka 100% CPU aur RAM kha jati hai, jiski wajah se Part 3 mein system 11 second ke liye latak gaya! Maine ise write path se hata diya aur compound index `{ userId: 1, createdAt: -1 }` lagaya."*

---

### Sawal 2: "Tumne apne rewrite mein double-spending kaise roki?"

#### 🗣️ Aapka Jawab:
> *"Sir, maine application memory mein balance check karne ke bajaye **MongoDB document-level atomic conditional update** use kiya:*
> ```javascript
> Wallets.findOneAndUpdate(
>   { userId: userId, balance: { $gte: amountPaise } },
>   { $inc: { balance: -amountPaise } }
> )
> ```
> *MongoDB is operation ke waqt document pe exclusive lock leta hai. Agar 2 requests 1 millisecond ke andar aati hain, toh sirf pehli request balance ko deduct karegi. Doosri request ke liye `balance >= amount` false ho jayega aur MongoDB null return karega. Double-spend ho hi nahi sakta."*

---

### Sawal 3: "Float ka kya issue tha aur paise mein kyun convert kiya?"

#### 🗣️ Aapka Jawab:
> *"JavaScript mein IEEE-754 floating point arithmetic hoti hai. Jaise `0.1 + 0.2 = 0.30000000000000004` ho jata hai. Millions of transactions ke baad paiso mein rounding drift aa jata hai. Isliye banking standard ke mutabiq hum saara paisa integer **paise** mein store karte hain (₹100 = 10,000 paise). Saath hi negative numbers (`amount: -500`) ko block kiya taaki koi wallet balance badha na sake."*

---

## 📌 Part 2: Schema & Reward Points Design

### Sawal 1: "Tumne Point Collections kaise design kiye?"

#### 🗣️ Aapka Jawab:
> *"Sir, 3 main collections hain:*
> 1. **`PointWallets`**: Har user ka real-time balance (`availablePoints`, `lifetimeEarned`, `lifetimeConverted`). Unique index on `{ userId: 1 }`.
> 2. **`PointTransactions`**: Append-only immutable ledger jisme har point ka lifecycle event record hota hai (`EARNED`, `CONVERTED`, `EXPIRED`).
> 3. **`PointConversionRates`**: Dynamic rate ka audit trail (`rateInInr`, `effectiveFrom`, `effectiveTo`). Rate change hone par bhi purana conversion rate auditable rehta hai."*

---

### Sawal 2: "40 Million records pe monthly finance report fast kaise generate hogi?"

#### 🗣️ Aapka Jawab:
> *"Teen architectural decisions ki wajah se yeh pipeline ultra-fast hai:*
> 1. **Zero-Join Architecture (Denormalized Cohort):** Maine transaction record mein hi user ka `cohort` (e.g. `'2026-09'`) store kiya hai. Isse 40M records pe koi heavy `$lookup` (SQL JOIN) nahi lagana padta.
> 2. **Covering Index:** Index banaya hai `{ cohort: 1, createdAt: 1, type: 1 }`. Pipeline ka pehla stage `$match` is index ko use karke poore table ko scan kiye bina sirf us month ke records filter kar leta hai.
> 3. **Single-Pass Conditional Aggregation:** `$group` stage mein `$cond` use kiya hai:
>    ```javascript
>    pointsEarned: { $sum: { $cond: [{ $eq: ['$type', 'EARNED'] }, '$points', 0] } }
>    ```
>    Ek hi pass mein earned, converted aur expired points calculate ho jaate hain bina multiple queries ke."*

---

### Sawal 3: "Agar user do baar simultaneously convert click kare toh double-conversion kaise rokoge?"

#### 🗣️ Aapka Jawab:
> *"Two-tier protection hai:  
> Pehla, client-side se **Idempotency Key** aati hai jo uniquely index hoti hai.  
> Doosra, `PointWallets` pe atomic conditional decrement lagaya hai:  
> `{ userId, availablePoints: { $gte: pointsToConvert } }` with `$inc: { availablePoints: -pointsToConvert }`.  
> Agar user ke paas 100 points hain aur usne 2 baar 100 points convert karne ki koshish ki, toh pehla update 100 points minus kar dega, aur doosra update fail ho jayega kyunki balance 0 ho chuka hoga."*

---

## 📌 Part 3: 9 PM Payout Outage Incident (Production Scenario)

### Situation:
- 9:00 PM, payout day.
- p95 latency 300ms se 11s chali gayi.
- Support par complaints: "Money debited but not received."
- Aapne yeh system nahi likha.

---

### 🗣️ Aapka Jawab (Step-by-step Triage):

#### Minute 0–4: Stop the Bleeding (Pehle aag bujhao)
> *"Sabse pehle root cause dhoondne mein waqt barbad karne ke bajaye **bleeding rokna zaroori hai**.  
> Jab latency 11 second ho gayi hai aur mobile app 10 second pe retry kar rahi hai, toh system ek **exponential retry storm** mein phas gaya hai!  
> 1. API gateway ya Cloudflare pe `POST /api/wallet/withdraw` ko temporarily throttle karunga ya degraded response return karunga (`429/503: Withdrawal queued, please do not retry`). Isse naye retries aana band ho jayenge aur DB connection pool recover hoga.  
> 2. Support team aur Slack pe incident declare karke bolunga ki users ko bole: 'Aapka balance safe hai, retry mat kijiye, 2 ghante mein reconcile ho jayega.'
>
> **Main kya NAHI karunga:**  
> - Main Node.js pods ko blindly restart ya scale-up nahi karunga! Kyunki agar bottleneck database hai, toh pods badhane se database par aur zyada queries ka load padega aur database crash ho jayega.  
> - Main blind automated refunds ya gateway replays nahi chalaunga jab tak confirm na ho ki kisko paisa mila aur kisko nahi."*

#### Minute 4–12: Telemetry Check Across 3 Dashboards
> *"1. **MongoDB Atlas:** Real-time metrics dekhunga — CPU 100% hai kya? Disk IOPS saturated hai kya?  
> Mongo shell command: `db.currentOp({ "secs_running": { $gte: 3 } })`. Agar wahan 40M Ledger pe `COLLSCAN` aur in-memory sort dikhta hai, toh samajh aa gaya ki database kahan phas raha hai.  
> 2. **Payment Gateway Dashboard:** Error rate dekhunga — kya gateway 429/504 de raha hai? Kya banking partner ke IMPS switch mein queue atki hai?  
> 3. **App Logs:** `grep "gateway error"` chalake dekhunga ki kya gateway calls fail ho rahi hain aur code use swallow kar raha hai."*

#### Minute 12–22: Surgical Fix
> *"1. MongoDB par lambi chal rahi queries ko kill karunga: `db.killOp(opid)`.  
> 2. Background index build karunga: `db.Ledger.createIndex({ userId: 1, createdAt: -1 }, { background: true })`.  
> 3. Write path se wo unindexed history query hata ke quick hotfix deploy karunga."*

#### Minute 22–30: Reconciliation & Recovery
> *"Incident window (8:00 PM se 9:30 PM) ke Ledger debits ko Gateway API status se match karunga via reconciliation script.  
> Jinka gateway par fail ho gaya tha, unka balance wallet mein automatically credit wapas karunga WITHDRAWAL_REFUND ke sath aur SMS bhejunga. System stabilize hone ke baad rate limit hata dunga."*

---

## 📌 Part 4: Loom Screen Recording (3.5 Min Spoken Script)

Record karte waqt aap screen par `part1-code-review/withdraw.handler.js` khol ke rakhein aur camera on rakhein.

### 🎙️ Word-for-Word Script (Bolo aise):

> *"Hi Anik, Payal, and the Funngro team!  
> I’m Mayank. In this video, I’m walking you through my code review and rewrite of the payout handler for Part 1.  
>
> When looking at this endpoint, my core principle was: **we are moving real money for teenagers.** That means zero tolerance for balance drift, zero tolerance for race conditions, and complete resilience under bad network connectivity.
>
> *(Highlight lines in code)*  
> **The first and most dangerous bug I found was the un-awaited gateway call with swallowed errors.**  
> In the original code, `gateway.createPayout` was called without `await`, and the `try/catch` just did a `console.log`. If the bank details were wrong or the gateway failed with a 502, the error was swallowed, the user's wallet was debited, the ledger marked it as complete, and the API said 'Success!'. The teenager lost their balance without receiving the payout. That destroys customer trust immediately.  
> In my rewrite, the gateway response is awaited. If it fails terminally, an automatic compensating refund restores the teenager's wallet balance.
>
> *(Highlight the findOneAndUpdate line)*  
> **The second most dangerous bug was the non-atomic check-then-act race condition.**  
> The original code checked `if (wallet.balance >= amount)` in Node memory and then did an `updateOne`. Two concurrent clicks from a user would both pass the check, allowing a ₹1,000 balance to withdraw ₹2,000!  
> In my rewrite, I moved this to an atomic MongoDB conditional update:  
> `findOneAndUpdate({ userId, balance: { $gte: amountPaise } }, { $inc: { balance: -amountPaise } })`.  
> MongoDB's document-level lock ensures only one request can ever succeed, completely eliminating double-spending.
>
> *(Highlight the 202 Accepted response)*  
> **Now, the one decision in my rewrite that I wanted to highlight and ask you about:**  
> In the original code, it attempts to resolve the payout synchronously inside the HTTP lifecycle. But real IMPS/UPI banking switches often take 3 to 10 seconds, which exhausts socket connections and triggers the mobile app's 10-second retry timeout.  
> In my rewrite, I implemented an asynchronous flow returning `202 Accepted` with a deterministic reference and unique idempotency key, allowing workers or webhooks to settle the final state.
>
> **The question I would have asked you is:**  
> *'Does Funngro's mobile app currently require a synchronous green-tick confirmation within the same HTTP call, or do you already have WebSockets or status polling in place to update the teenager's screen once the gateway webhook arrives?'*  
> If synchronous is strictly needed, we can keep the HTTP request open with strict timeouts, but the asynchronous event-driven pattern I wrote is far more scalable for millions of users.
>
> I have also completed the Reward Points schema in Part 2, the 9 PM incident runbook in Part 3, and full MongoDB Compass testing.  
> Really excited to discuss this with you in person in Indore. Thank you!"*

---

## 🎯 Pro-Tips for Your Indore Interview:
1. **Pehle "Why" bolo, fir "How":** Hamesha pehle financial impact batao (e.g. *"Is bug se user ka paisa kho jayega ya company ka loss hoga"*), fir technical fix batao.
2. **Confidence:** Agar wo koi tricky question puchein, toh ghabraiye mat — rule simple hai: **"Money path hamesha atomic aur idempotent hona chahiye."**
