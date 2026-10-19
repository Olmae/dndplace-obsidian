import type {NoteChoice,TransferResult,Review} from './controller.js';
import type {ConflictChoice} from '../sync/conflicts.js';
export type PanelConflictChoice=ConflictChoice|'local';
export type ConflictReview={id:string;choice:PanelConflictChoice;path:string;targetPath:string;stage?:'capture'|'server';server?:Review;canConfirm?:boolean};
export type ConflictApplyResult=TransferResult|{kind:'review';review:ConflictReview};
export type ConflictModel={id:string;title:string;path:string;localText:string;remoteText:string;revision:number;decision:ConflictReview|null};
export type ConflictPanelService={open:(localId:string,note:NoteChoice,signal:AbortSignal)=>Promise<ConflictModel>;preview:(localId:string,id:string,choice:PanelConflictChoice,signal:AbortSignal)=>Promise<ConflictReview>;apply:(localId:string,id:string,signal:AbortSignal)=>Promise<ConflictApplyResult>;dispose:()=>void};
