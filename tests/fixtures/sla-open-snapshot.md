---
title: SLA Open Items
created: 2026-04-15
updated: 2026-04-23 09:05 UTC
tags: [emails, sla, ledger]
zone: business
---

# SLA Open Items

Last computed: 2026-04-23 09:05 UTC
Open: 8 | Breached: 2 (fast: 0, normal: 2, slow: 0)

<!--
One-shot migration — 2026-04-22 21:05 UTC (ai-brain#100 Phase 2):
  Added `Category` column (user_category per new taxonomy).
  6 rows dropped as user_category=noise.
    Breached: 19d9a856758a9eb4, 19da1fc63101aa79, 19da87bbec3d36f5, 19da9a8ff32bf279
    Open: 19daee7c31e763a1, 19daebaf154bdeb5
  1 row reclassified: 19daee1bb02bac83 Yen Nhi "Invitation: Final Interview Apr 24" → r-user (superseded 2026-04-23 — now awareness)

Post-migration manual drop — 2026-04-22 21:33 UTC (follow-up to b7dad125 audit):
  Breached: 19d99458ba59bc63, 19da8c31abc1f50b dropped.

One-shot migration — 2026-04-23 09:05 UTC (automation-sender rule + invitation-awareness rule + manual offline-resolve):
  Paired with commits cf060c00 (gmail-rules.md #5 automation-sender rule) + 105c3f5 (render-status awareness guard).
  12 rows dropped as user_category=awareness — they carry no reply obligation, so must not enter the ledger (taxonomy A×A / A×N).
    Breached (2 dropped — were wrongly tagged fast-tier):
      - 19db3621aa0b44b3  Hetzner "Credit card charge failed" (billing@hetzner.com — automation sender)
      - 19db3d3eb08b9344  PingPong "Suspicious Login Attempt" (already category=awareness but in ledger at tier=fast)
    Open (9 dropped):
      - 19db4707dc06eb0a  Anthropic "organization has used 75%" (no-reply@mail.anthropic.com)
      - 19db759c63e6a687  Airwallex "Action required" (no-reply@info.airwallex.com — escalation wording elevates to mark-important, not SLA)
      - 19d97aaffdd1b01c  Claude Team "Introducing Opus 4.7" (no-reply@email.claude.com)
      - 19d97b21305f0d93  Google Fitbit (noreply@e.fitbit.com)
      - 19d9a053d54fc96e  Interactive Brokers (donotreply@interactivebrokers.com)
      - 19d9ad032a01ee2e  PandaDoc "Signed copy Biên bản" (docs@email.pandadoc.net)
      - 19da15e063afafc7  Stripe "Start setting up" (notifications@stripe.com)
      - 19dad670ffbe7c91  Hetzner "Invoice 087000885209" (billing@hetzner.com)
      - 19db382be53e56c1  Nam Nguyen passthrough invoice fwd (accounting@emvn.co notification)
      - 19db5efae08e924b  Stripe "Activate your Stripe account" (notifications@stripe.com)
  1 row dropped (invitation-awareness rule):
      - 19daee1bb02bac83  Yen Nhi "Invitation: Final Interview Apr 24" → awareness (accept/decline is 1-click in calendar client, not an email reply obligation)
  1 row moved to Resolved (user told team directly, offline):
      - 19da4e4ed895baf2  Florian & Sandra license — team replied but did not CC team inbox
  (Vlad 19da4f24de3cd634 already auto-resolved by 09:00 UTC run — team reply detected at 2026-04-23T08:01:56Z.)
  1 row left Breached pending investigation:
      - 19da0bbfa059d5c2  Emad Yaghoubi — user says team replied but guard #4 rejected reply as Auto-Submitted. Next triage run's verbose guard-failure log (per updated gmail-triage.md §8 step 7) will name the raw header value so the fail can be diagnosed.
-->

## Breached
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Overdue | Status | Category |
|------|-------|------|----|---------|------------|----------------|-----------------|---------|--------|----------|
| normal | hr | Thi Yen Nhi Vu <vtynhi110@gmail.com> | hr@emvn.co | "Re: [EMVN] YouTube Channel Optimizer - Final Interview Invitation" | 19daec604f50608a | 2026-04-21 06:41 | 2026-04-23 06:41 | ~2.4h | 🔴 breached | team-sla-at-risk |
| normal | business | Emad Yaghoubi <emadeyaghoubi@gmail.com> | business@emvn.co | "Clarification on Payments and Reporting" | 19da0bbfa059d5c2 | 2026-04-18 13:15 | 2026-04-22 13:15 | ~1.8 bd | 🔴 breached | team-sla-at-risk |

## Open (within SLA)
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Remaining | Status | Category |
|------|-------|------|----|---------|------------|----------------|-----------------|-----------|--------|----------|
| normal | hr | Minh Ngọc <th.thuy6123@gmail.com> | hr@emvn.co | "Re: [EMVN] Digital Distribution Operator - Application Result" | 19db063d1396b8ff | 2026-04-21 14:13 | 2026-04-23 14:13 | ~5.2h ⚠️ | ⏳ open | team-sla-at-risk |
| normal | license | George Kolganov <via license@emvn.co> | license@emvn.co | "Relaxed Mind & Mediacube" | 19db33eb518738b6 | 2026-04-22 03:31 | 2026-04-24 03:31 | ~18.5h (~0.8 bd) | ⏳ open | team-sla-at-risk |
| normal | legal | Peter Roe <ptarvain84@gmail.com> | legal@emvn.co | "Re: Last Reunion Buy-out Offer" | 19d910676a6495d7 | 2026-04-22 19:17 | 2026-04-24 19:17 | ~34.3h (~1.4 bd) | ⏳ open | team-sla-at-risk |
| normal | legal | Matt Whitmire <via legal@emvn.co> | legal@emvn.co | "Re: Youtube Publishing CMS" | 19db6ac46b9dcc1a | 2026-04-22 19:29 | 2026-04-24 19:29 | ~34.5h (~1.4 bd) | ⏳ open | team-sla-at-risk |
| slow | legal | Jenny Ng <via legal@emvn.co> | legal@emvn.co | "Update On Certification Service - Tunebot Ltd. - Order ID. 55465" | 19da9ad3b972c63c | 2026-04-20 06:56 | 2026-04-27 06:56 | ~94h (~3.9 bd) | ⏳ open | team-sla-at-risk |
| slow | support | Eddy Fuller <eddy@feltmusic.com> | support@emvn.co | "Re: Felt Music/EMVN Update" | 19daa553aa0c2094 | 2026-04-20 09:59 | 2026-04-27 09:59 | ~97h (~4.0 bd) | ⏳ open | team-sla-at-risk |
| slow | business | '411 Music Group' via Business Development <business@emvn.co> | business@emvn.co | "My, Mirage x 411 Music Group Partnership: New application is live!" | 19db1a1417e7db72 | 2026-04-21 20:00 | 2026-04-28 20:00 | ~131h (~5.5 bd) | ⏳ open | team-sla-at-risk |
| slow | me-business | EMVN Legal <legal@emvn.co> | business@emvn.co | "Fwd: Last Reunion Buy-out Offer" | 19db344791c990ba | 2026-04-22 03:38 | 2026-04-29 03:38 | ~114.6h (~4.8 bd) | ⏳ open | team-sla-at-risk |

## Resolved (last 7 days, audit trail)
| Tier | Owner | From | Subject | Message ID | Received | Resolved (UTC) | Resolved by |
|------|-------|------|---------|------------|----------|----------------|-------------|
| normal | license | Florian & Sandra <via license@emvn.co> | "Re: Florian Boucansaud's Licensing Inquiry" | 19da4e4ed895baf2 | 2026-04-19 08:39 | 2026-04-23 09:05 UTC | user told team offline (manual resolve — team replied but did not CC team inbox, so guard #3 rejected; no email audit trail) |
| normal | legal | 'Thanh Hoang' via EMVN Legal / Vlad Kolomensky | "Re: Legal Service for setting up Swedish company" | 19da4f24de3cd634 | 2026-04-19 08:53 | 2026-04-23 09:00 UTC | 'Thanh Hoang' via EMVN Legal <legal@emvn.co> — replied to Vlad Kolomensky <vlk@mediacube.io> at 2026-04-23T08:01:56Z; all 4 guards met |
| normal | me-personal | Eman <eman@metrical.ae> | "Statement from Metrical Real Estate Development – Unit 810, Leven Residence" | 19db4b8000f802f3 | 2026-04-22 10:24 | 2026-04-23 06:29 UTC | sonthanhdo2004@gmail.com — replied to eman@metrical.ae at 06:29 UTC; all 4 guards met |
| normal | hr | Raymond Tu <tu.duongvy@gmail.com> | "yêu cầu về chứng từ thuế" | 19da3b9e8c7f880e | 2026-04-20 10:44 | 2026-04-23 03:04 UTC | Ân Đào <accounting@emvn.co> — replied to Raymond Tu with PDF; all 4 guards met |
| normal | business | manu malik <manu_malik_2000@yahoo.ca> | "Follow-up Re: RFD007 & RFD008 - Reality From Dreams" | 19daff1c016a4b7b | 2026-04-21 12:08 | 2026-04-22 09:14 UTC | My Nguyễn (partners@emvn.co) — replied; confirmed by Support Diep (support@emvn.co) 09:33 UTC; all 4 guards met |
| slow | legal | Kelli Glancey <kelliglancey@hotmail.com> | "Re: LEGAL Contract Questions? Proceed!" | 19db4072b30404c8 | 2026-04-22 07:10 | 2026-04-22 07:10 UTC | EMVN Legal (legal@emvn.co) — sent revised three-party contract; all 4 guards met |
| normal | partners | Chris Noxx <chris@fnmpg.com> | "Re: Posthaste" | 19d879c4fea35459 | 2026-04-16 07:22 | 2026-04-22 07:56 UTC | My Nguyễn (partners@emvn.co) — replied re Q4/2025 distribution report; all 4 guards met |
| normal | business | Thanh Hoang / Finanshuset | "Re: Invoice issue: Royalty from UMG Singapore" | 19db361a2e1d9b23 | 2026-04-22 04:09 | 2026-04-22 06:20 UTC | Thanh Hoang <business@emvn.co> — replied to info@finanshuset.nu; all 4 guards met |
| normal | legal | Peter Roe <ptarvain84@gmail.com> | "Re: Last Reunion Buy-out Offer" | 19d910676a6495d7 | 2026-04-21 06:12 | 2026-04-21 16:26 UTC | legal@emvn.co (re-opened 17:41 UTC by Peter Roe follow-up; re-opened again 19:17 UTC Apr 22 — see Open table) |
| normal | business | Linh via business@emvn.co | "Đề nghị thực hiện kê khai Tổng điều tra kinh tế năm 2026 (nhắc lần 2)" | 19da7df307fa8fbc | 2026-04-19 22:01 | 2026-04-21 20:00 UTC | business@emvn.co (Linh — replied to vnlinhhcm@nso.gov.vn on Apr 20 05:01 UTC; all 4 guards met) |
| normal | business | EMVN Legal <legal@emvn.co> | "Fwd: Last Reunion Buy-out Offer" | 19db0d9773bdc5ba | 2026-04-21 16:21 | 2026-04-21 20:00 UTC | legal@emvn.co (handled external correspondence with Peter Roe; CEO-awareness item closed) |
| normal | accounting | Account Dự Án <account.tcda@mcv.com.vn> | "Re: [MCV x EMVN] Đối soát doanh thu hàng tháng" | 19daebc206a687dc | 2026-04-21 06:30 | 2026-04-21 10:00 UTC | accounting@emvn.co (Ân Đào — final reply at 06:53 UTC to mcv.com.vn; all 4 guards met) |
| normal | support | Support Partner <support@emvn.co> | "Action Required: Artwork Rejection for Release 'Lingering Suspicion'" | 19daa1ec792f1db7 | 2026-04-20 08:59 | 2026-04-21 07:00 UTC | support@emvn.co (artwork rejection notification sent; all 4 guards met) |
| slow | business | Jerker Edström <jerker.edstrom@stroem.com> | "Legal service for Swedish company" | 19d99696a73421a1 | 2026-04-20 11:02 | 2026-04-21 05:00 UTC | legal@emvn.co (EMVN Legal / Hoai Le — replied with entity info) |
| slow | legal | Jenny Ng <via legal@melosy.net> | "Re: Cert of Incumbency - Melosy Ltd. CTC in process" | 19da9b91881115d9 | 2026-04-20 07:08 | 2026-04-21 05:00 UTC | accounting@emvn.co (Melosy Legal via Accounting — acknowledged CTC receipt) |
| fast | me-business | Jules O'Riordan <jules@soundadvicellp.com> | "RE: Introduction" | 19d885f2d6e16420 | 2026-04-13 19:43 | 2026-04-17 06:00 UTC | thanh.hoang@emvn.co |
| fast | support | Austin Henderson <706muzik@gmail.com> | "Re: Your receipt from Music Master #2854-9494" | 19d98779a9dcc2d0 | 2026-04-16 22:44 | 2026-04-17 21:30 UTC | user forwarded to support team |
| fast | me-personal | Facebook <notification@facebookmail.com> | "Did you just create a passkey?" | 19d9ade5b15798dd | 2026-04-17 09:55 | 2026-04-17 20:30 UTC | user (verified and cleaned directly) |
| slow | legal | Jenny Ng via Melosy Legal | "Re: Cert of Incumbency - Order 55464 & 55465 - Melosy & Tunebot - BVI" | 19d9aa3103a2e0f2 | 2026-04-17 08:50 | 2026-04-17 17:00 UTC | legal@melosy.net |
| fast | me-personal | Google <no-reply@accounts.google.com> | "Security alert for sonthanhdo2004@gmail.com" | 19d9cca0b8c5a49c | 2026-04-17 18:52 | 2026-04-18 15:05 UTC | user (dismissed via Gmail) |
| normal | me-personal | trinh huong <taodohotel@gmail.com> | "Re: Lịch hẹn nộp hồ sơ visa ngày 28/4" | 19da564f81a2e60c | 2026-04-19 10:59 | 2026-04-19 14:00 UTC | sonthanhdo2004@gmail.com |
| normal | me-business | Menta Music Copyright <copyright@mentamusic.com> | "Re: Menta Music - Multiple Copyright Claims - Totto Land" | 19d9f4b29ede5d8e | 2026-04-18 06:33 | 2026-04-20 04:29 UTC | partners@emvn.co (Melosy Support) |
| normal | me-business | Peter Roe <ptarvain84@gmail.com> | "Re: Last Reunion Buy-out Offer" | 19d910676a6495d7 | 2026-04-16 09:04 | 2026-04-20 02:59 UTC | EMVN Legal <legal@emvn.co> (re-opened 06:12 UTC — Peter Roe follow-up) |
| normal | accounting | Raymond Tu <tu.duongvy@gmail.com> | "yêu cầu về chứng từ thuế" | 19da3b9e8c7f880e | 2026-04-19 03:12 | 2026-04-20 09:13 UTC | hr-admin@emvn.co (Thu Hoang) (re-opened 10:44 UTC — Raymond Tu confirmation) |
| normal | me-business | Adam Frank <adam.f@hypseeteam.org> | "Re: Just seen your channel in Youtube" | 19dab37c3ac8bac3 | 2026-04-20 14:07 | 2026-04-20 17:03 UTC | sonthanhdo2004@gmail.com |
| normal | legal | NCT (Nguyễn Lê Quỳnh Anh) <via legal@emvn.co> | "Trả lời: [NCT] Trao đổi về việc sử dụng bản quyền các sản phẩm âm nhạc thuộc kho Extensive Music Sweden AB" | 19daaa85d9b0569f | 2026-04-20 11:30 | 2026-04-20 22:00 UTC | legal@emvn.co (outgoing follow-up to Extensive Music Copyright Team) |

<!--
Resolution check 2026-04-23 04:00 UTC (run T04):
  NEW EMAILS: 25 (11 archived, 13 read, 1 mark-important = Airwallex 19db759c63e6a687)
  NEW SLA APPEND: Airwallex 19db759c63e6a687 (normal/accounting; breach 2026-04-24 22:40 UTC) — note: rule change 2026-04-23 would reclassify this as awareness + sla_tier=none; dropped in 09:05 UTC migration.
  RESOLUTION SWEEP:
    - 19da3b9e8c7f880e (Raymond Tu): RESOLVED — Ân Đào replied 2026-04-23 03:04 UTC; all 4 guards met.
    - 19db3621aa0b44b3 (Hetzner failed charge): no reply → STILL BREACHED (rule change: should not have been in ledger)
    - 19db3d3eb08b9344 (PingPong suspicious login): no reply → STILL BREACHED (rule change: should not have been in ledger)
    - 19da0bbfa059d5c2 (Emad Yaghoubi): guard #4 fail (auto-submitted) → STILL BREACHED — investigate
    - 19da4e4ed895baf2 (Florian): external follow-up Apr 19, no team reply since Apr 16 → STILL BREACHED
    - 19da4f24de3cd634 (Vlad): Vlad replied Apr 19, no team reply → STILL BREACHED
  IMMINENT: Yen Nhi hr@ 06:41 UTC, Minh Ngọc hr@ 14:13 UTC.

Resolution check 2026-04-23 06:30 UTC (run T06):
  NEW EMAILS: 5 (all Cremi Team outbound replies — archived as noise)
  RESOLUTION SWEEP:
    - 19db4b8000f802f3 (Eman): RESOLVED — sonthanhdo2004@gmail.com replied 2026-04-23 06:29 UTC (08:29 CEST); all 4 guards met.
    - Same-as-T04 notes for Hetzner / PingPong / Emad / Florian / Vlad → STILL BREACHED.

Resolution check 2026-04-23 09:00 UTC (run T09):
  NEW EMAILS: 30 (29 archived as noise — mostly external replies to Cremi outreach threads + Cremi-Team outbound; 1 read).
  RESOLUTION SWEEP:
    - 19da4f24de3cd634 (Vlad Kolomensky): RESOLVED — 'Thanh Hoang' via EMVN Legal replied to Vlad <vlk@mediacube.io> at 2026-04-23T08:01:56Z; all 4 guards met.
    - Yen Nhi hr@ crossed 06:41 → moved Open→Breached.
    - Hetzner / PingPong / Emad / Florian still breached at this run; dropped in 09:05 cleanup migration above.
  ⚠ This run RE-INTRODUCED rows we had already cleaned at 08:50 UTC (stale checkout — rule commit cf060c00 landed ~08:50 but workflow at 09:00 was already running against the pre-rule state). Manifests the "no deterministic post-classification guard" gap — see gmail-triage.md § "Prevention" for the planned fail-fast validator.
-->
