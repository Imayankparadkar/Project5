# Part 4: Walkthrough Recording Guide (Loom / Screen Recording)

**Target Audience:** Anik & Payal (Founders, Funngro)  
**Target Duration:** 3.5 to 4.5 minutes (Strictly under 5 minutes)  
**Screen Setup:** Split screen in VS Code / IDE:  
- **Left Window:** `part1-code-review/withdraw.handler.js`  
- **Right Window:** `part1-code-review/review.md`  
- **Camera:** Video bubble enabled in the bottom corner (collegial, confident tone).

---

## ⏱️ Video Timeline Breakdown

```
0:00 - 0:30  | Introduction & High-Level Philosophy (Fintech for Teenagers)
0:30 - 1:45  | Bug #1: Un-awaited / Swallowed Gateway Error (Direct User Fund Loss)
1:45 - 2:45  | Bug #2: Non-Atomic Balance Check Race Condition (Direct Company Loss)
2:45 - 3:45  | Key Rewrite Decisions: Post-Commit Dispatch, Timeouts & Idempotency
3:45 - 4:15  | The Design Question for Funngro & Closing
```

---

## 🎙️ Spoken Script (English — Primary Loom Delivery)

### 1. Introduction (0:00 – 0:30)
> *"Hi Anik, Payal, and the Funngro team! I'm Mayank. Thank you for reviewing my backend engineering assessment.*  
> *Today, I'm walking you through my code review and rewrite of the payout withdrawal handler.*  
> *When reviewing this endpoint, my guiding principle was clear: **we are moving real money for teenagers.** In fintech, user trust is fragile. We need zero balance drift, zero tolerance for double-spend exploits, and absolute resilience under flaky mobile connections."*

---

### 2. The Two Most Dangerous Bugs (0:30 – 2:45)

#### Bug #1: Fire-and-Forget Gateway Call with Swallowed Errors (Direct User Fund Loss)
*(Action: Hover cursor over `review.md` Bug #1, then point to `withdraw.handler.js` Step 6)*
> *"The single most dangerous bug in the original code is how the payment gateway was called.*  
> *`gateway.createPayout()` was fired **without `await`**, and the `catch` block simply did a `console.log` and swallowed the error.*  
> *In production, if a teenager enters an invalid IFSC, or the banking partner times out, the error is silenced. The server writes a debit entry to the ledger and returns `ok: true`.*  
> *The teenager sees ₹2,000 deducted from their Funngro wallet, but the money never reached their bank. When dealing with young users, this immediately breaks trust in the platform.*  
> *In my rewrite, I separated the database transaction from the gateway call. The money is reserved in an atomic transaction first, and the gateway is awaited only **after** the database commits."*

#### Bug #2: Non-Atomic Check-Then-Act Race Condition (Direct Company Loss)
*(Action: Hover cursor over `review.md` Bug #2, then point to `withdraw.handler.js` Step 5b)*
> *"The second critical vulnerability is the classic TOCTOU race condition in the balance check.*  
> *The original code performed a `Wallets.findOne`, checked `balance >= amount` in Node.js memory, and then executed a separate `updateOne`.*  
> *If a user taps the withdraw button rapidly or runs a concurrent script, two requests see the exact same balance at the same time. Both pass, and both deduct balance.*  
> *A teenager with ₹1,000 can withdraw ₹2,000, and Funngro absorbs that financial loss directly.*  
> *In my rewrite at Step 5b, I eliminated this entirely with an atomic conditional update: `findOneAndUpdate` with `{ balance: { $gte: amountPaise } }` and `$inc: -amountPaise`. MongoDB's document-level lock guarantees that only one request can ever pass; concurrent requests fail cleanly with `INSUFFICIENT_BALANCE`."*

---

### 3. Key Design Decisions in the Rewrite (2:45 – 3:45)
*(Action: Scroll through `withdraw.handler.js` Steps 4, 6, and 7)*
> *"A few other critical financial protections in this rewrite:*  
> *1. **Strict Integer Paise:** All money calculations are integers in paise—no floating-point rounding errors.*  
> *2. **Idempotency with SHA-256 Request Hash:** We require a unique `x-idempotency-key`. If a mobile retry arrives with the exact same payload, it safely returns the existing payout status without re-debiting. If someone tampers with the amount using the same key, it returns `409 Conflict`.*  
> *3. **The Golden Fintech Rule on Timeouts:** If the gateway times out, we **never** auto-refund. The funds might already be moving through the IMPS switch. We transition the payout to `PENDING_RECONCILIATION` and let banking webhooks or a status reconciler settle it.*  
> *4. **Single-Attempt Refund on Terminal Failure:** If and only if the bank returns a definitive rejection—like an invalid account number—do we execute a conditional state transition to `FAILED` and credit the wallet back atomically."*

---

### 4. Ambiguous Decision & Question for the Team (3:45 – 4:15)
*(Action: Transition to closing view)*
> *"The key architectural question I would discuss with your product team before deploying this to production is:*  
> **'What is the mobile app's UX expectation during payout settlement?'**  
> *Does the teenager expect a synchronous confirmation screen within the same HTTP request, or does the mobile app already support polling or WebSockets to show a 'Processing' state while webhooks confirm the transfer?*  
> *Knowing that helps decide whether to keep this post-commit dispatch model or transition to an asynchronous Transactional Outbox worker with BullMQ.*  
>  
> *I've also documented the unindexed 40-million-row Ledger query triage in Part 3 and the monthly finance aggregation pipeline in Part 2. All 14 automated tests are passing cleanly.*  
> *Thank you Anik and Payal, and I look forward to meeting you for the in-person interview in Indore!"*

---

## 🇮🇳 Hinglish Cheatsheet (Agar aap Hinglish / Hindi mix me bolna chahein)

- **Intro:** "Hi Anik aur Payal! Main Mayank hoon. Aaj main Funngro assessment ke payout handler rewrite ka walkthrough de raha hoon. Mera focus tha ki teenagers ke real money ke sath zero balance drift aur zero double-spending ho."
- **Bug 1 (Swallowed Gateway Error):** "Original code mein `gateway.createPayout()` await nahi tha aur catch block mein error swallow ho raha tha. Iska matlab invalid IFSC par bhi wallet se paise kat jaate the aur ledger mein 'complete' likh jata tha. Maine gateway call ko post-commit synchronous banaya aur errors ko properly isolate kiya."
- **Bug 2 (Race Condition):** "Lines 7-12 mein `findOne` ke baad memory check tha. Rapid double-clicks par dono request 1000 balance dekh ke 2000 withdraw kar leti thi. Maine isko `findOneAndUpdate` with `{ balance: { $gte: amount } }` se database-level atomic lock mein badal diya."
- **Timeout Rule:** "Fintech ka golden rule hai: gateway timeout par kabhi auto-refund mat karo, kyunki IMPS switch se paisa nikal chuka ho sakta hai. Isliye timeout ko `PENDING_RECONCILIATION` mark kiya hai."
- **Question for Founders:** "Mera question Anik aur Payal ke liye yeh tha ki Funngro ka mobile app synchronous confirmation chahta hai ya webhook-driven async status update? Uske according hum isse further scale kar sakte hain."
