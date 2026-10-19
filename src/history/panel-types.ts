import type {NoteChoice} from '../ui/controller.js';
export type HistoryItem={id:string;label:string;revision:number|null;source:string;actor:string;createdAt:string|null;deleted:boolean};
export type HistoryList={id:string;title:string;path:string;items:HistoryItem[];nextCursor:string|null;remoteStatus:'server'|'cache'|'unavailable'|'forbidden'|'unlinked';fetchedAt:string|null;siteUrl?:string};
export type HistoryPreview={id:string;label:string;text:string;currentText:string|null;origin:'server'|'cache'|'local';fetchedAt:string|null};
export type HistoryRestoreReview={id:string;path:string;label:string;text:string;currentText:string};
export type HistoryModel=HistoryList&{active:HistoryPreview|null;compare:HistoryPreview|null;restoreAvailable?:boolean;restore?:HistoryRestoreReview|null};
export type HistoryPanelService={restore?:{preview:(localId:string,listId:string,itemId:string,signal:AbortSignal)=>Promise<HistoryRestoreReview>;apply:(localId:string,id:string,signal:AbortSignal)=>Promise<{written:number;pending:number}>};list:(localId:string,note:NoteChoice,cursor:string|undefined,signal:AbortSignal)=>Promise<HistoryList>;read:(localId:string,listId:string,itemId:string,signal:AbortSignal)=>Promise<HistoryPreview>;dispose:()=>void};
