
import type {
  OpenSurface as UiOpenSurface,
  EditResult as UiEditResult,
  VersionEntry as UiVersionEntry,
  RunStatus as UiRunStatus,
  RunRecord as UiRunRecord,
  RunPlan as UiRunPlan,
  AutomationEntry as UiAutomationEntry,
  EnableResult as UiEnableResult,
  Thread as UiThread,
  ThreadSummary as UiThreadSummary,
  InClientVenue as UiInClientVenue,
  ShipDiff as UiShipDiff,
  PinDrift as UiPinDrift,
  PinRebaseResult as UiPinRebaseResult,
  AdoptionVenue as UiAdoptionVenue,
  AdoptResult as UiAdoptResult,
} from "@vendoai/ui";
import type {
  OpenSurface as AppsOpenSurface,
  EditResult as AppsEditResult,
  VersionEntry as AppsVersionEntry,
  InClientVenueState as AppsInClientVenueState,
  ShipDiff as AppsShipDiff,
  PinDrift as AppsPinDrift,
  PinRebaseResult as AppsPinRebaseResult,
} from "@vendoai/apps";
import type {
  AutomationsEngine,
  RunStatus as AutomationsRunStatus,
  RunRecord as AutomationsRunRecord,
  RunPlan as AutomationsRunPlan,
  AdoptionCard as AutomationsAdoptionCard,
} from "@vendoai/automations";
import type {
  Thread as AgentThread,
  ThreadSummary as AgentThreadSummary,
} from "@vendoai/agent";

type AutomationsEntry = Awaited<ReturnType<AutomationsEngine["list"]>>[number];
type AutomationsEnableResult = Awaited<ReturnType<AutomationsEngine["enable"]>>;
type AutomationsAdoptResult = Awaited<ReturnType<AutomationsEngine["adopt"]>>;
type Assignable<Source, Target> = [Source] extends [Target] ? true : false;
type Assert<T extends true> = T;

type Checks = [
  Assert<Assignable<UiOpenSurface, AppsOpenSurface>>,
  Assert<Assignable<AppsOpenSurface, UiOpenSurface>>,
  Assert<Assignable<UiEditResult, AppsEditResult>>,
  Assert<Assignable<AppsEditResult, UiEditResult>>,
  Assert<Assignable<UiVersionEntry, AppsVersionEntry>>,
  Assert<Assignable<AppsVersionEntry, UiVersionEntry>>,
  Assert<Assignable<UiInClientVenue, AppsInClientVenueState>>,
  Assert<Assignable<AppsInClientVenueState, UiInClientVenue>>,
  Assert<Assignable<UiShipDiff, AppsShipDiff>>,
  Assert<Assignable<AppsShipDiff, UiShipDiff>>,
  Assert<Assignable<UiPinDrift, AppsPinDrift>>,
  Assert<Assignable<AppsPinDrift, UiPinDrift>>,
  Assert<Assignable<UiPinRebaseResult, AppsPinRebaseResult>>,
  Assert<Assignable<AppsPinRebaseResult, UiPinRebaseResult>>,
  Assert<Assignable<UiRunStatus, AutomationsRunStatus>>,
  Assert<Assignable<AutomationsRunStatus, UiRunStatus>>,
  Assert<Assignable<UiRunRecord, AutomationsRunRecord>>,
  Assert<Assignable<AutomationsRunRecord, UiRunRecord>>,
  Assert<Assignable<UiRunPlan, AutomationsRunPlan>>,
  Assert<Assignable<AutomationsRunPlan, UiRunPlan>>,
  Assert<Assignable<UiAutomationEntry, AutomationsEntry>>,
  Assert<Assignable<AutomationsEntry, UiAutomationEntry>>,
  Assert<Assignable<UiEnableResult, AutomationsEnableResult>>,
  Assert<Assignable<AutomationsEnableResult, UiEnableResult>>,
  Assert<Assignable<UiThread, AgentThread>>,
  Assert<Assignable<AgentThread, UiThread>>,
  Assert<Assignable<UiThreadSummary, AgentThreadSummary>>,
  Assert<Assignable<AgentThreadSummary, UiThreadSummary>>,
  // Build contract §9.9 — the adoption ask rides an app's open payload and its
  // acceptance comes back off the adopt route, so both shapes cross the wire
  // and both are declared twice.
  Assert<Assignable<UiAdoptionVenue, AutomationsAdoptionCard>>,
  Assert<Assignable<AutomationsAdoptionCard, UiAdoptionVenue>>,
  Assert<Assignable<UiAdoptResult, AutomationsAdoptResult>>,
  Assert<Assignable<AutomationsAdoptResult, UiAdoptResult>>,
];
declare const checks: Checks;
void checks;
