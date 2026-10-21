// An isolated owner for the process-death acceptance scenario.
import { startDesktopPet, desktopPetState } from '../../packages/newmark-core/components/computeruse/lib/desktop-pet.js';
await startDesktopPet();
process.send({ event:'ready', state:desktopPetState() });
process.on('message', () => process.send({ event:'state', state:desktopPetState() }));
