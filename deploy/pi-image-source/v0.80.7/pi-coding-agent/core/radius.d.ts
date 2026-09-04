/**
 * Radius (pi-messages gateway) provider wiring.
 *
 * The main Radius provider is a built-in OAuth provider in pi-ai; models are
 * dynamic, cached on the stored OAuth credential (`gatewayConfig`) and
 * injected via the OAuth provider's `modifyModels` hook, so startup, /reload,
 * and registry refreshes work without network access. The catalog refreshes
 * on login and on every token refresh.
 *
 * Additional gateways (e.g. a local dev gateway) can be declared in
 * models.json with `"oauth": "radius"`; each entry is an independent Radius
 * instance with its own credentials and catalog.
 */
export declare const RADIUS_PROVIDER_ID = "radius";
/**
 * Register a Radius-style OAuth provider for a custom gateway declared in
 * models.json (`"oauth": "radius"`). Runs on every models.json load so the
 * registration survives `resetOAuthProviders()` during registry refreshes.
 */
export declare function registerCustomRadiusOAuthProvider(id: string, name: string | undefined, gateway: string): void;
//# sourceMappingURL=radius.d.ts.map