# Whiteboard competitor pricing

Checked 2026-10-03. USD, before applicable taxes. These are published competitor facts, not a validated price recommendation for this product.

| Product | Monthly billing | Annual billing, monthly equivalent | Free-plan boundary | Paid-plan positioning |
| --- | --- | --- | --- | --- |
| Excalidraw+ | $7/user/month | $6/user/month ($72/user/year) | One infinite scene, full editor, browser-local storage, unlimited collaborators | Unlimited cloud scenes and folders, sharing controls, presentations, teams and extended AI |
| Miro Starter | $10/member/month | $8/member/month ($96/member/year) | Three editable boards; older boards remain viewable | Unlimited private boards, visitor editing, high-resolution exports and collaboration tools |
| Whimsical Pro | $12/editor/month | $10/editor/month ($120/editor/year) | 50 new board objects and 50 doc blocks/month, 1 GB storage, 5 MB uploads, seven-day history | Unlimited objects/blocks, 100 GB storage, 1 GB uploads, 90-day history and watermark-free exports |

Sources:

- [Excalidraw+ pricing](https://plus.excalidraw.com/pricing). The page initially renders annual pricing. Its current official HTML meta description explicitly gives USD 6/user/month paid yearly and USD 7/user/month paid monthly. The comparison identifies free browser-local storage and paid cloud storage. Free guest sharing is listed on both plans.
- [Miro pricing](https://miro.com/pricing/) confirms Starter annual pricing and three editable free boards. [Miro billing](https://help.miro.com/hc/en-us/articles/360017571714-Miro-billing) explicitly confirms the $10 monthly Starter rate.
- [Whimsical pricing](https://whimsical.com/pricing), [workspace upgrade guide](https://whimsical.com/learn/workspaces/upgrade), and [pricing and discounts](https://whimsical.com/learn/billing/pricing) confirm Pro billing rates and free/paid limits. [Billing guide](https://whimsical.com/learn/billing/billing) states editors are billed while viewers and guests are free.

Competitors combine generous creative features with product-specific free allowances and charge for hosted persistence, collaboration, or higher usage. Their use of “unlimited” for boards or objects does not imply unlimited storage or every metered service: Whimsical's paid storage remains capped and its AI credits are separately purchased.

## Proposed launch model (judgment, not measured economics)

- Open-source self-hosted edition: full software available without subscription; users supply their own Firebase project and pay their own infrastructure bills. Current Functions and Storage require Blaze, so zero infrastructure cost cannot be promised. See [Firebase pricing](https://firebase.google.com/pricing) and [Storage requirements](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024).
- Hosted Free: unlimited local boards, core editor, exports and the existing local MCP workflow. If hosted free cloud saving is offered, start with a deliberately small allowance such as three cloud boards and 25 MB of assets per owner; these are provisional product limits, not Firebase entitlements or validated cost controls. Limit operation rates and collaboration/download usage as well.
- Hosted Pro: test **$6/month or $60/year per owner account**; viewers and occasional guests are free and their usage is attributed to the board owner. Unlimited boards and all existing features, with explicit storage, traffic, concurrent-collaboration and retention allowances. Dedicated team seats can be priced later. External agent/AI provider costs remain user-supplied rather than included without limits.
- Pool infrastructure capacity and budget, but expose stable per-owner product allowances. Do not make users race to consume an app-wide free quota. Track owner usage, free/paid cost allocation, and paid-service headroom separately. If the free budget is exhausted, restrict new free cloud allocations/admissions and expensive operations with a local fallback; continuing reads still costs money, so this is not a guaranteed zero-cost cap.
- If absolutely no free-user subsidy is acceptable, permanent free usage should be local or self-hosted. Hosted cloud can be paid or a finite evaluation. A freely accessible shared cloud service with ongoing persistence/collaboration has unavoidable cost exposure on Blaze.

### Underutilization and conversion

Light subscribers subsidizing heavier subscribers is a viable subscription mechanism, provided aggregate costs and the heavy-use tail are measured and bounded. Competitor pricing alone cannot establish a correct or profitable price.

Illustrative assumptions only: a hosted free user costs $0.05/month, and a paying user pays $6/month. At 3% conversion there are about 32.3 free users per paying user, costing **$1.62 per subscriber/month**. At 1% conversion there are 99 free users per paying user, costing **$4.95 per subscriber/month**. Both exclude the paying user's own infrastructure, payment fees, support, taxes and fixed costs. Annual revenue at $60/year is $5/month before those costs.

Free-user subsidy per paying user = free-user monthly cost × (1 − paying fraction) ÷ paying fraction.

Before finalizing allowances, measure active users, conversion, retained assets/history, database reads/writes, collaboration/download traffic, median and high-percentile per-owner costs, and support/payment costs. Test willingness to pay for hosted convenience and agent workflows; a price discount is not sufficient differentiation by itself.

The Firestore 1 MiB/document hard limit remains on paid plans too. Unlimited board count does not mean unlimited board size; larger scenes require a persistence redesign rather than merely a subscription upgrade. [Firestore limits](https://firebase.google.com/docs/firestore/quotas)
