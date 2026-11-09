import { serveVillagesMd } from "~/lib/md/twin.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
export { default, action } from "./not-found";
export const middleware = [({ request }: { request: Request }, next: () => Promise<Response>) => villagesEnabled() ? serveVillagesMd(request) : next()];
export function loader({ request }: { request: Request }) { return serveVillagesMd(request); }
