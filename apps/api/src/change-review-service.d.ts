import type { Prisma, PrismaClient } from "@prisma/client";
import type { ArtifactStore } from "@ai-qa/artifact-store";
type DB = PrismaClient | Prisma.TransactionClient;
export declare const contentHash: (v: unknown) => string;
export declare function ruleWire(row: any): {
    id: string;
    ruleId: string;
    version: number;
    statement: string;
    classification: "EXPLICIT" | "INFERRED" | "UNKNOWN";
    action: string;
    expectation: string;
    forbiddenBehaviors: string[];
    priority: "P0" | "P1" | "P2";
    businessFields: {
        key: string;
        value?: string | number | boolean | null | undefined;
        unit?: string | undefined;
        operator?: "contains" | "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "in" | "between" | undefined;
    }[];
    sources: {
        documentVersionId: string;
        sourceSpanIds: string[];
    }[];
    conflictsWith: string[];
    reviewStatus: "DRAFT" | "NEEDS_REVIEW" | "APPROVED" | "REJECTED" | "SUPERSEDED";
    supersedesId: string | null;
    origin: "manual" | "model";
    promptVersion: string | null;
    reviewedBy: string | null;
    reviewedAt: string | null;
    createdAt: string;
    role?: string | undefined;
    precondition?: string | undefined;
    condition?: string | undefined;
};
export declare function caseWire(row: any): {
    id: string;
    version: number;
    priority: "P0" | "P1" | "P2";
    supersedesId: string | null;
    origin: "manual" | "model";
    promptVersion: string | null;
    createdAt: string;
    ruleVersionIds: string[];
    caseId: string;
    title: string;
    roles: string[];
    preconditions: string[];
    dataSpec: {
        params: Record<string, string | number | boolean>;
        strategy: "fixture";
        fixtureId: string;
    } | {
        strategy: "create";
        note: string;
    };
    steps: {
        id: string;
        role: string;
        action: string;
        expectedResult?: string | undefined;
    }[];
    assertions: {
        operator: "equals" | "notEquals" | "contains" | "notContains" | "gt" | "gte" | "lt" | "lte" | "matches" | "exists" | "notExists";
        id: string;
        description: string;
        kind: "ui.text" | "ui.element" | "ui.state" | "data.value" | "api.response" | "download.content" | "visual";
        required: boolean;
        ruleVersionId: string;
        expected?: string | number | boolean | null | undefined;
        unit?: string | undefined;
    }[];
    cleanup: {
        strategy: "manual" | "fixture" | "namespace";
        note?: string | undefined;
    };
    approvalStatus: "DRAFT" | "NEEDS_REVIEW" | "APPROVED" | "REJECTED" | "SUPERSEDED";
    description?: string | undefined;
    approvalHash?: string | undefined;
};
export declare function loadReviewBundle(db: DB, store: ArtifactStore, projectId: string, id: string): Promise<{
    row: {
        document: {
            id: string;
            createdAt: Date;
            title: string;
            projectId: string;
        };
        sourceSpans: {
            documentVersionId: string;
            id: string;
            createdAt: Date;
            locator: Prisma.JsonValue;
            quotedText: string | null;
            extractionQuality: string;
            imageRegion: Prisma.JsonValue | null;
        }[];
    } & {
        id: string;
        version: number;
        createdAt: Date;
        mode: string;
        format: string;
        parseStatus: string;
        parserVersion: string | null;
        coverageSummary: Prisma.JsonValue;
        storageKey: string;
        documentId: string;
        fileSizeBytes: number | null;
        checksum: string;
        bundleStorageKey: string | null;
        bundleChecksum: string | null;
        parseWarnings: Prisma.JsonValue;
    };
    bundle: {
        documentVersionId: string;
        format: "MARKDOWN" | "TXT" | "DOCX" | "PDF_TEXT" | "PDF_SCANNED" | "PNG" | "JPEG";
        parseStatus: "NEEDS_OCR" | "PENDING" | "PARSING" | "PARSED" | "FAILED";
        parserVersion: string;
        blocks: {
            id: string;
            kind: "heading" | "paragraph" | "table" | "listItem" | "image";
            text: string;
            page?: number | undefined;
            imageStorageKey?: string | undefined;
        }[];
        spans: {
            documentVersionId: string;
            id: string;
            locator: {
                kind: "markdown-line";
                startLine: number;
                endLine: number;
            } | {
                path: string[];
                kind: "markdown-heading";
            } | {
                kind: "docx-paragraph";
                paragraphIndex: number;
            } | {
                kind: "docx-cell";
                tableIndex: number;
                row: number;
                col: number;
            } | {
                kind: "pdf-page";
                page: number;
            } | {
                kind: "image-region";
                bbox: number[];
            };
            quotedText: string | null;
            extractionQuality: "GOOD" | "LOW" | "UNPARSED";
        }[];
        coverageSummary: {
            totalBlocks: number;
            goodSpans: number;
            lowSpans: number;
            unparsedSpans: number;
        };
        warnings: string[];
    };
}>;
export declare function freezeReviewInput(db: DB, store: ArtifactStore, projectId: string, baselineId: string, oldId: string, newId: string): Promise<{
    input: {
        approvedRuleVersions: {
            id: string;
            ruleId: string;
            version: number;
            statement: string;
            classification: "EXPLICIT" | "INFERRED" | "UNKNOWN";
            action: string;
            expectation: string;
            forbiddenBehaviors: string[];
            priority: "P0" | "P1" | "P2";
            businessFields: {
                key: string;
                value?: string | number | boolean | null | undefined;
                unit?: string | undefined;
                operator?: "contains" | "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "in" | "between" | undefined;
            }[];
            sources: {
                documentVersionId: string;
                sourceSpanIds: string[];
            }[];
            conflictsWith: string[];
            reviewStatus: "DRAFT" | "NEEDS_REVIEW" | "APPROVED" | "REJECTED" | "SUPERSEDED";
            supersedesId: string | null;
            origin: "manual" | "model";
            promptVersion: string | null;
            reviewedBy: string | null;
            reviewedAt: string | null;
            createdAt: string;
            role?: string | undefined;
            precondition?: string | undefined;
            condition?: string | undefined;
        }[];
        approvedCaseVersions: {
            id: string;
            version: number;
            priority: "P0" | "P1" | "P2";
            supersedesId: string | null;
            origin: "manual" | "model";
            promptVersion: string | null;
            createdAt: string;
            ruleVersionIds: string[];
            caseId: string;
            title: string;
            roles: string[];
            preconditions: string[];
            dataSpec: {
                params: Record<string, string | number | boolean>;
                strategy: "fixture";
                fixtureId: string;
            } | {
                strategy: "create";
                note: string;
            };
            steps: {
                id: string;
                role: string;
                action: string;
                expectedResult?: string | undefined;
            }[];
            assertions: {
                operator: "equals" | "notEquals" | "contains" | "notContains" | "gt" | "gte" | "lt" | "lte" | "matches" | "exists" | "notExists";
                id: string;
                description: string;
                kind: "ui.text" | "ui.element" | "ui.state" | "data.value" | "api.response" | "download.content" | "visual";
                required: boolean;
                ruleVersionId: string;
                expected?: string | number | boolean | null | undefined;
                unit?: string | undefined;
            }[];
            cleanup: {
                strategy: "manual" | "fixture" | "namespace";
                note?: string | undefined;
            };
            approvalStatus: "DRAFT" | "NEEDS_REVIEW" | "APPROVED" | "REJECTED" | "SUPERSEDED";
            description?: string | undefined;
            approvalHash?: string | undefined;
        }[];
        comparison: {
            path: string;
            oldBundle: {
                documentVersionId: string;
                format: "MARKDOWN" | "TXT" | "DOCX" | "PDF_TEXT" | "PDF_SCANNED" | "PNG" | "JPEG";
                parseStatus: "NEEDS_OCR" | "PENDING" | "PARSING" | "PARSED" | "FAILED";
                parserVersion: string;
                blocks: {
                    id: string;
                    kind: "heading" | "paragraph" | "table" | "listItem" | "image";
                    text: string;
                    page?: number | undefined;
                    imageStorageKey?: string | undefined;
                }[];
                spans: {
                    documentVersionId: string;
                    id: string;
                    locator: {
                        kind: "markdown-line";
                        startLine: number;
                        endLine: number;
                    } | {
                        path: string[];
                        kind: "markdown-heading";
                    } | {
                        kind: "docx-paragraph";
                        paragraphIndex: number;
                    } | {
                        kind: "docx-cell";
                        tableIndex: number;
                        row: number;
                        col: number;
                    } | {
                        kind: "pdf-page";
                        page: number;
                    } | {
                        kind: "image-region";
                        bbox: number[];
                    };
                    quotedText: string | null;
                    extractionQuality: "GOOD" | "LOW" | "UNPARSED";
                }[];
                coverageSummary: {
                    totalBlocks: number;
                    goodSpans: number;
                    lowSpans: number;
                    unparsedSpans: number;
                };
                warnings: string[];
            };
            newBundle: {
                documentVersionId: string;
                format: "MARKDOWN" | "TXT" | "DOCX" | "PDF_TEXT" | "PDF_SCANNED" | "PNG" | "JPEG";
                parseStatus: "NEEDS_OCR" | "PENDING" | "PARSING" | "PARSED" | "FAILED";
                parserVersion: string;
                blocks: {
                    id: string;
                    kind: "heading" | "paragraph" | "table" | "listItem" | "image";
                    text: string;
                    page?: number | undefined;
                    imageStorageKey?: string | undefined;
                }[];
                spans: {
                    documentVersionId: string;
                    id: string;
                    locator: {
                        kind: "markdown-line";
                        startLine: number;
                        endLine: number;
                    } | {
                        path: string[];
                        kind: "markdown-heading";
                    } | {
                        kind: "docx-paragraph";
                        paragraphIndex: number;
                    } | {
                        kind: "docx-cell";
                        tableIndex: number;
                        row: number;
                        col: number;
                    } | {
                        kind: "pdf-page";
                        page: number;
                    } | {
                        kind: "image-region";
                        bbox: number[];
                    };
                    quotedText: string | null;
                    extractionQuality: "GOOD" | "LOW" | "UNPARSED";
                }[];
                coverageSummary: {
                    totalBlocks: number;
                    goodSpans: number;
                    lowSpans: number;
                    unparsedSpans: number;
                };
                warnings: string[];
            };
        };
    };
    mode: string;
}>;
export declare function verifyReviewOutput(input: unknown, output: unknown): {
    sourceReport: {
        path: string;
        format: "MARKDOWN" | "TXT" | "DOCX" | "PDF_TEXT" | "PDF_SCANNED" | "PNG" | "JPEG";
        oldDocumentVersionId: string;
        newDocumentVersionId: string;
        changes: ({
            path: string;
            kind: "added";
            reason: null;
            old: null;
            new: {
                documentVersionId: string;
                id: string;
                locator: {
                    kind: "markdown-line";
                    startLine: number;
                    endLine: number;
                } | {
                    path: string[];
                    kind: "markdown-heading";
                } | {
                    kind: "docx-paragraph";
                    paragraphIndex: number;
                } | {
                    kind: "docx-cell";
                    tableIndex: number;
                    row: number;
                    col: number;
                } | {
                    kind: "pdf-page";
                    page: number;
                } | {
                    kind: "image-region";
                    bbox: number[];
                };
                quotedText: string | null;
                extractionQuality: "GOOD" | "LOW" | "UNPARSED";
            };
        } | {
            path: string;
            kind: "removed";
            reason: null;
            old: {
                documentVersionId: string;
                id: string;
                locator: {
                    kind: "markdown-line";
                    startLine: number;
                    endLine: number;
                } | {
                    path: string[];
                    kind: "markdown-heading";
                } | {
                    kind: "docx-paragraph";
                    paragraphIndex: number;
                } | {
                    kind: "docx-cell";
                    tableIndex: number;
                    row: number;
                    col: number;
                } | {
                    kind: "pdf-page";
                    page: number;
                } | {
                    kind: "image-region";
                    bbox: number[];
                };
                quotedText: string | null;
                extractionQuality: "GOOD" | "LOW" | "UNPARSED";
            };
            new: null;
        } | {
            path: string;
            kind: "modified";
            reason: null;
            old: {
                documentVersionId: string;
                id: string;
                locator: {
                    kind: "markdown-line";
                    startLine: number;
                    endLine: number;
                } | {
                    path: string[];
                    kind: "markdown-heading";
                } | {
                    kind: "docx-paragraph";
                    paragraphIndex: number;
                } | {
                    kind: "docx-cell";
                    tableIndex: number;
                    row: number;
                    col: number;
                } | {
                    kind: "pdf-page";
                    page: number;
                } | {
                    kind: "image-region";
                    bbox: number[];
                };
                quotedText: string | null;
                extractionQuality: "GOOD" | "LOW" | "UNPARSED";
            };
            new: {
                documentVersionId: string;
                id: string;
                locator: {
                    kind: "markdown-line";
                    startLine: number;
                    endLine: number;
                } | {
                    path: string[];
                    kind: "markdown-heading";
                } | {
                    kind: "docx-paragraph";
                    paragraphIndex: number;
                } | {
                    kind: "docx-cell";
                    tableIndex: number;
                    row: number;
                    col: number;
                } | {
                    kind: "pdf-page";
                    page: number;
                } | {
                    kind: "image-region";
                    bbox: number[];
                };
                quotedText: string | null;
                extractionQuality: "GOOD" | "LOW" | "UNPARSED";
            };
        } | {
            path: string;
            kind: "uncertain";
            reason: string;
            old: {
                documentVersionId: string;
                id: string;
                locator: {
                    kind: "markdown-line";
                    startLine: number;
                    endLine: number;
                } | {
                    path: string[];
                    kind: "markdown-heading";
                } | {
                    kind: "docx-paragraph";
                    paragraphIndex: number;
                } | {
                    kind: "docx-cell";
                    tableIndex: number;
                    row: number;
                    col: number;
                } | {
                    kind: "pdf-page";
                    page: number;
                } | {
                    kind: "image-region";
                    bbox: number[];
                };
                quotedText: string | null;
                extractionQuality: "GOOD" | "LOW" | "UNPARSED";
            };
            new: {
                documentVersionId: string;
                id: string;
                locator: {
                    kind: "markdown-line";
                    startLine: number;
                    endLine: number;
                } | {
                    path: string[];
                    kind: "markdown-heading";
                } | {
                    kind: "docx-paragraph";
                    paragraphIndex: number;
                } | {
                    kind: "docx-cell";
                    tableIndex: number;
                    row: number;
                    col: number;
                } | {
                    kind: "pdf-page";
                    page: number;
                } | {
                    kind: "image-region";
                    bbox: number[];
                };
                quotedText: string | null;
                extractionQuality: "GOOD" | "LOW" | "UNPARSED";
            } | null;
        })[];
    };
    impact: {
        affectedRules: {
            ruleVersionId: string;
            reason: string;
            evidenceRefs: {
                documentVersionId: string;
                spanId: string;
            }[];
            suggestion: string;
        }[];
        affectedCases: {
            caseVersionId: string;
            reason: "RULE_SOURCE_CHANGED";
            suggestion: string;
            viaRuleVersionIds: string[];
        }[];
        unresolved: string[];
        requiresHumanReview: true;
    };
};
export declare function reviewTasks(output: unknown): {
    key: string;
    assetType: string;
    assetVersionId: string;
}[];
export {};
