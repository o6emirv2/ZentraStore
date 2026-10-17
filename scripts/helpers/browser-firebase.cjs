'use strict';
// Browser SDK boundary for isolated UI checks; no external Firebase account or secret is used.
module.exports = `
export function getApps(){return globalThis.__qaApps||(globalThis.__qaApps=[]);}
export function initializeApp(options,name){const app={name,options};getApps().push(app);return app;}
export function getApp(name){return getApps().find(app=>app.name===name);}
export function getAuth(){if(!globalThis.__qaAuth){const identity=globalThis.__qaIdentity;const user=identity?{...identity,emailVerified:true,getIdToken:async()=>identity.token}:null;globalThis.__qaAuth={currentUser:user,useDeviceLanguage(){},authStateReady:async()=>{}};}return globalThis.__qaAuth;}
export function onAuthStateChanged(auth,next){queueMicrotask(()=>next(auth.currentUser));return()=>{};}
export async function setPersistence(){} export const browserLocalPersistence={},browserSessionPersistence={},inMemoryPersistence={};
export async function signOut(auth){auth.currentUser=null;}
export class ReCaptchaEnterpriseProvider{} export function initializeAppCheck(){return{};} export async function getToken(){return{token:'fixture-appcheck'};}
`;
