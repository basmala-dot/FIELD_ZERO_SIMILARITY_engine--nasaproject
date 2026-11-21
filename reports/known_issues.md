# FIELD//ZERO integration: known issues and limits

Ordered by how much they can mislead a reader.

## Interpretation risks

1. **Two energy/time models disagree by design.** The planner estimates energy from physics (mass, rolling resistance, gravity); the simulator uses a power-based model. For the SAFE route in the test mission the planner estimates 2,496 Wh, the simulation consumes 1,278 Wh. The UI shows simulated values; planner estimates appear in hover text, `planner.planner_estimate` and the dossier. Neither is measured. Reconciling the models belongs to the owners of those engines.
2. **No success probability exists.** No engine produces one, so none is shown. The "Success chance" labels became "Rehearsal outcome" / "Simulated outcome" (a verdict from mission-results). `risk` is the failure-analysis heuristic index, explicitly not a probability.
3. **Cost is in abstract CU, not money.** The cost engine's rates are placeholders. A user budget is compared only when the currency field is blank or "CU"; otherwise the comparison is withheld and the reason shown.
4. **A scenario run shows the interrupted state.** After a blocked-leg failure, duration/energy/cost are the values up to the failure. The result of the evaluated recovery (for example "SUCCESS · 20 h 9 min") appears in an "After recovery" comparison row and in the failure panel. The post-recovery continuation is not available as a full run with its own cost.
5. **Charging is zero.** No solar or power model exists for the route, so `WAIT_RECHARGE` is reported infeasible for battery failures (correct for this data, but it means no recharge recovery can ever succeed).

## Scope limits of the what-if lab

6. Events start at a **leg boundary** (the leg active at the trigger time). Mid-leg onset is not modelled.
7. Only route-condition events are offered (blocked leg, traction loss, steeper terrain, longer path). Battery health and power draw exist in the scenario engine as whole-run changes but cannot start mid-run in the simulation, so they are not triggerable events.
8. Default magnitudes (speed x0.5, +8 deg, x1.5 length) are assumed what-if values. The UI says so, and the magnitude field overrides them.
9. **Probability** is one deterministic seeded draw (mulberry32) deciding whether the event occurs. It is not a Monte Carlo estimate.
10. **Detour recovery needs room.** A detour is planned with a keep-out zone around an interior cell of the blocked leg. One-cell legs cannot be bypassed this way; the run then reports no detour and a limitation line. (In the test mission 5 of 13 SAFE legs are single cell steps.)

## Planning behaviour to be aware of

11. **Destination "Earth" is rejected** with an explanatory message: the planner needs Mars or Moon as the similarity target. The option remains in the builder because the shell predates the planner.
12. **SCIENTIFIC does not necessarily visit your chosen site.** FAST and SAFE route to it; SCIENTIFIC visits the engine's top-ranked sites. This is stated in the plan's assumptions.
13. **Start is engine-proposed** for Earth rehearsals (lowest-risk interior cell near the best-scoring site) unless supplied. This is the planner's documented assumption.
14. **Mars/Moon rehearsal needs manual start and goal in metres.** There is no map picker, and no similarity-based site ranking exists on those bodies. Positions outside the known grid, or on blocked cells, are rejected by the planner with its own message.
15. Roughness per leg comes from the terrain table (mean and max over the leg's cells); slope uses the planner's step grade and cell slope. If a leg has no roughness data it is passed as unknown.
16. Simulated rover lon/lat on Earth is **interpolated** between real route cell centres because the simulator emits x/y only. Positions are on the route polyline by construction.
17. Hazard circles on the map mark simulated failure points and scenario injections; the 60 m radius is a drawing size, not a modelled hazard extent.
18. Playback replays the completed simulation; it does not step the engine live. Values at any moment come from the simulated trace.
19. Equipment has mass and power but no cost-per-hour or availability data in the builder, so equipment cost lines are zero and availability is reported as unknown.

## Verification gaps

20. `scripts/smoke_test_dom.js` cannot run here (jsdom not installed, no network). It failed identically before the changes.
21. Browser verification used stubbed Leaflet and Chart.js (CDN blocked); see `integration_report.md` section 8.
22. The browser script is not in the repository.
