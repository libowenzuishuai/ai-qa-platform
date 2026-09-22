import type { LoginPreparation } from "@prisma/client";
export declare const configHash: (value: unknown) => string;
export declare function validateLoginConfiguration(raw: unknown, runtimeRaw: unknown): {
    role: string;
    steps: ({
        value: {
            source: "credential";
            ref: string;
        };
        type: "fill";
        locator: {
            value: string;
            type: "testId";
        } | {
            type: "role";
            role: string;
            name?: string | undefined;
        } | {
            value: string;
            type: "label";
        } | {
            value: string;
            type: "text";
        };
    } | {
        type: "click";
        locator: {
            value: string;
            type: "testId";
        } | {
            type: "role";
            role: string;
            name?: string | undefined;
        } | {
            value: string;
            type: "label";
        } | {
            value: string;
            type: "text";
        };
    })[];
    timeoutMs: number;
    environmentId: string;
    loginPath: string;
    credentialRef: string;
    successIndicator: {
        locator: {
            value: string;
            type: "testId";
        } | {
            type: "role";
            role: string;
            name?: string | undefined;
        } | {
            value: string;
            type: "label";
        } | {
            value: string;
            type: "text";
        };
        expectedText?: string | undefined;
        expectedUrl?: string | undefined;
    };
    validityHours: number;
    invalidIndicator?: {
        value: string;
        type: "testId";
    } | {
        type: "role";
        role: string;
        name?: string | undefined;
    } | {
        value: string;
        type: "label";
    } | {
        value: string;
        type: "text";
    } | undefined;
    interactiveIndicator?: {
        value: string;
        type: "testId";
    } | {
        type: "role";
        role: string;
        name?: string | undefined;
    } | {
        value: string;
        type: "label";
    } | {
        value: string;
        type: "text";
    } | undefined;
};
export declare function loginFresh(row: LoginPreparation, revision: number): boolean;
