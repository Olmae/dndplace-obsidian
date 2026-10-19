import type {DownloadDocument} from '../sync/pull.js';
export type HistoryHeader={id:number;entityType:'note'|'folder';entityId:string;revision:number;deleted:boolean;source:'site'|'import'|'obsidian'|'ai'|'baseline';actor:{id:string;name:string}|null;createdAt:string};
export type HistoryPage={protocolVersion:1;rows:HistoryHeader[];nextCursor:string|null};
export type HistoryDetail={protocolVersion:1;change:HistoryHeader;document:DownloadDocument|null;folder:{id:string;name:string;parentId:string|null;revision:number}|null};
