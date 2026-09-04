import { Container, type Focusable } from "@earendil-works/pi-tui";
import type { AuthStatus, AuthStorage } from "../../../core/auth-storage.ts";
export type AuthSelectorProvider = {
    id: string;
    name: string;
    authType: "oauth" | "api_key";
};
export declare function formatAuthSelectorProviderType(authType: AuthSelectorProvider["authType"]): string;
/**
 * Component that renders an auth provider selector
 */
export declare class OAuthSelectorComponent extends Container implements Focusable {
    private searchInput;
    private _focused;
    get focused(): boolean;
    set focused(value: boolean);
    private listContainer;
    private allProviders;
    private filteredProviders;
    private selectedIndex;
    private mode;
    private authStorage;
    private getAuthStatus;
    private onSelectCallback;
    private onCancelCallback;
    private showAuthTypeLabels;
    constructor(mode: "login" | "logout", authStorage: AuthStorage, providers: AuthSelectorProvider[], onSelect: (providerId: string, authType: AuthSelectorProvider["authType"]) => void, onCancel: () => void, getAuthStatus?: (providerId: string) => AuthStatus, initialSearchInput?: string);
    private filterProviders;
    private updateList;
    private formatStatusIndicator;
    handleInput(keyData: string): void;
}
//# sourceMappingURL=oauth-selector.d.ts.map