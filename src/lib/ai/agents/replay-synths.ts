// Registers every agent's replay synthesiser with the ReplayTransport registry (D-024).
// Imported for its side effect by src/lib/ai/transport-factory.ts. Synthesisers are pure and
// build answers from request.scenarioMeta only. Add one line per agent.

import { registerReplaySynth } from "../transport-replay";
import { curatorReplaySynth } from "./curator-replay";
import { storytellerReplaySynth } from "./storyteller-replay";

registerReplaySynth("curator", curatorReplaySynth);
registerReplaySynth("storyteller", storytellerReplaySynth);
