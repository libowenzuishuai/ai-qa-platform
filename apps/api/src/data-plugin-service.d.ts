export declare function validateDataParameters(schema: unknown, raw: unknown): Record<string, string | number | boolean>;
export declare function parseDataDefinition(value: unknown): {
    cleanup: {
        path: string;
        method: "DELETE";
        allow404: boolean;
    };
    timeoutMs: number;
    prepare: {
        path: string;
        method: "POST" | "PUT";
    };
    inspect: {
        path: string;
        method: "GET";
    };
};
