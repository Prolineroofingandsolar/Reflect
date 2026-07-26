"use strict";

const storageKey = "reflect-os-profile-v4";
const legacyStorageKey = "reflect-os-profile-v2";
const previousStorageKey = "reflect-os-profile-v3";
const deviceDataKey = "reflect-os-device-data-v1";
const zones = [["top-left","Top left"],["top-centre","Top centre"],["top-right","Top right"],["middle-left","Middle left"],["centre","Centre"],["middle-right","Middle right"],["bottom-left","Bottom left"],["bottom-centre","Bottom centre"],["bottom-right","Bottom right"]];
const baseWidgets = {
  clock: { label: "Clock", addOn: null },
  weather: { label: "Weather", addOn: "weather" },
  calendar: { label: "Calendar", addOn: "googleCalendar" },
  tasks: { label: "Tasks", addOn: null },
  affirmations: { label: "Affirmations", addOn: null },
  music: { label: "Spotify", addOn: "spotify" },
  smartHome: { label: "Smart Home", addOn: "smartHome" },
  photos: { label: "Photos", addOn: "photos" }
};
let addOnRegistry = {
  spotify: { id:"spotify", name:"Spotify", icon:"S", description:"Now playing, search, recent tracks, playback controls, and a mirror-safe music widget.", category:"media", version:"1.2", screens:["Music"], widgets:["Now Playing"], permissions:["Playback status", "Control playback", "Recently played tracks"], requiresConnection:true, view:"music" },
  googleCalendar: { id:"googleCalendar", name:"Google Calendar", icon:"31", description:"Daily agenda, upcoming events, week view, and calendar widgets.", category:"productivity", version:"1.0", screens:["Calendar"], widgets:["Agenda"], permissions:["Read calendar events"], requiresConnection:true, view:"calendar" },
  weather: { id:"weather", name:"Weather", icon:"°", description:"Current weather, forecasts, rain, wind, sunrise, and sunset.", category:"utilities", version:"1.0", screens:["Weather"], widgets:["Current Weather"], permissions:["Approximate location"], requiresConnection:false, view:"weather", preinstalled:true },
  smartHome: { id:"smartHome", name:"Smart Home", icon:"H", description:"Live Home Assistant control for lights, switches, climate, locks and scenes.", category:"home", version:"1.0", screens:["Smart Home"], widgets:["Home Summary"], permissions:["Home Assistant devices"], requiresConnection:true, view:"homekit" },
  photos: { id:"photos", name:"Photos", icon:"P", description:"A private slideshow made from photos stored only on this mirror.", category:"personal", version:"1.0", screens:[], widgets:["Photo Slideshow"], permissions:["Files you choose"], requiresConnection:false, view:"addons" }
};
const defaultAddOnState = {
  spotify:{installed:false,enabled:false,connectionStatus:"disconnected",lastSync:"",error:""},
  googleCalendar:{installed:false,enabled:false,connectionStatus:"disconnected",lastSync:"",error:""},
  weather:{installed:true,enabled:true,connectionStatus:"connected",lastSync:"Local forecast",error:""},
  smartHome:{installed:false,enabled:false,connectionStatus:"disconnected",lastSync:"",error:""},
  photos:{installed:false,enabled:false,connectionStatus:"connected",lastSync:"Stored on this mirror",error:""}
};
const defaultProfile = {
  version:4, personName:"Will", greetingPrefix:"Good", accentColor:"#9d7cff", clockFormat:"24", defaultView:"home", navTimeout:3600,
  weather:{place:"London",latitude:51.5072,longitude:-0.1276},
  account:{signedIn:false,name:"Will",email:"will@example.com",id:""},
  addOns:defaultAddOnState,
  spotify:{widgetMode:"standard",deviceName:"Living room speaker",autoplay:false,playlist:"Mirror Focus",playlistUri:""},
  affirmations:{mode:"affirmations",interval:30,custom:[]},
  photos:{ids:[],interval:15,fit:"cover",order:"ordered",brightness:82},
  widgets:{clock:{visible:true,zone:"top-left",size:"large",priority:1},weather:{visible:true,zone:"top-right",size:"medium",priority:1},calendar:{visible:false,zone:"bottom-left",size:"medium",priority:1},tasks:{visible:true,zone:"bottom-right",size:"medium",priority:1},affirmations:{visible:false,zone:"bottom-centre",size:"medium",priority:2},music:{visible:false,zone:"bottom-centre",size:"medium",priority:1},smartHome:{visible:false,zone:"middle-right",size:"small",priority:1},photos:{visible:false,zone:"centre",size:"large",priority:1}}
};
const sampleData = {
  events:[],
  tasks:[],
  smartHome:["Living room lights 42%","Heating 20.5°","Front door locked"],
  track:{title:"Nothing playing",artist:"Spotify",album:"Open Spotify on a device",progress:0,playing:false}
};
let weatherData = null;
const affirmationLibrary = {
  affirmations:[
    "You are capable of amazing things.","Today is full of possibility.","Breathe in calm, breathe out tension.",
    "You are exactly where you need to be.","Small steps still move you forward.","You have everything you need within you.",
    "Be proud of how far you've come.","Your presence makes a difference.","Choose progress over perfection.",
    "You are worthy of good things.","Make today count.","You are stronger than you think.",
    "Kindness starts with yourself.","Trust yourself — you've got this.","Every day is a fresh start."
  ],
  quotes:[
    {t:"The best way to predict the future is to create it.",a:"Peter Drucker"},
    {t:"What you do today can improve all your tomorrows.",a:"Ralph Marston"},
    {t:"It always seems impossible until it's done.",a:"Nelson Mandela"},
    {t:"Well done is better than well said.",a:"Benjamin Franklin"},
    {t:"The secret of getting ahead is getting started.",a:"Mark Twain"},
    {t:"Do what you can, with what you have, where you are.",a:"Theodore Roosevelt"},
    {t:"Little things make big days.",a:"Isabel Marant"},
    {t:"Quality is not an act, it is a habit.",a:"Aristotle"},
    {t:"Simplicity is the ultimate sophistication.",a:"Leonardo da Vinci"},
    {t:"Act as if what you do makes a difference. It does.",a:"William James"}
  ]
};
let affirmationIndex = 0, affirmationTimer;

const $ = (id) => document.getElementById(id);
const views = document.querySelectorAll(".view");
const nav = $("quickNav");
const navItems = document.querySelectorAll(".nav-item");
const layoutGrid = $("layoutGrid");
const widgetSettings = $("widgetSettings");
const addonsGrid = $("addonsGrid");
const addonDetail = $("addonDetail");
const profileInputs = {personName:$("personName"),greetingPrefix:$("greetingPrefix"),accentColor:$("accentColor"),clockFormat:$("clockFormat"),defaultView:$("defaultView"),navTimeout:$("navTimeout"),weatherPlace:$("weatherPlace"),spotifyWidgetMode:$("spotifyWidgetMode"),spotifyDevice:$("spotifyDevice"),spotifyAutoplay:$("spotifyAutoplay")};
let profile = loadProfile();
let hideTimer, longPressTimer, slideshowTimer, photoDb;
let touchStartX = 0, isEditing = false, selectedWidget = "clock", calendarView = "day", taskFilter = "today", storeTab = "discover", currentPhoto = 0;
let photoRecords = [], photoUrls = new Map();
let spotifyPlayer = null, spotifyDeviceId = "", spotifyActiveDeviceId = "", spotifySdkLoading = false, spotifyNeedsPlaybackPermission = false, spotifyNeedsRecentPermission = false, spotifySearchResults = [], spotifyRecentTracks = [];
let homeAssistantEntities = [];
let spotifyPlaylists = [];

function clone(value){ return JSON.parse(JSON.stringify(value)); }
function esc(value){ return String(value ?? "").replace(/[&<>'"]/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]); }
function loadProfile(){
  try { const saved=JSON.parse(localStorage.getItem(storageKey) || localStorage.getItem(previousStorageKey) || localStorage.getItem(legacyStorageKey)); return mergeProfile(saved); }
  catch { return clone(defaultProfile); }
}
function mergeProfile(saved={}){
  if(!saved || typeof saved!=="object") return clone(defaultProfile);
  const next=clone(defaultProfile);
  Object.assign(next,saved,{version:4});
  next.account={...defaultProfile.account,...(saved.account||{})};
  next.spotify={...defaultProfile.spotify,...(saved.spotify||{})};
  next.weather={...defaultProfile.weather,...(saved.weather||{})};
  next.photos={...defaultProfile.photos,...(saved.photos||{})};
  next.affirmations={...defaultProfile.affirmations,...(saved.affirmations||{})};
  if(!Array.isArray(next.affirmations.custom))next.affirmations.custom=[];
  next.addOns=clone(defaultAddOnState);
  Object.keys(addOnRegistry).forEach((id)=>{
    const old=saved.addOns?.[id]||{};
    next.addOns[id]={...next.addOns[id],...old};
    if(Number(saved.version||0)<3){
      const widgetId={spotify:"music",googleCalendar:"calendar",smartHome:"smartHome"}[id];
      if(old.connected || (widgetId && saved.widgets?.[widgetId]?.visible)) next.addOns[id]={...next.addOns[id],installed:true,enabled:true,connectionStatus:old.connected?"connected":"disconnected"};
    }
  });
  next.widgets=clone(defaultProfile.widgets);
  Object.keys(baseWidgets).forEach((id)=>{ next.widgets[id]={...next.widgets[id],...(saved.widgets?.[id]||{})}; });
  Object.keys(next.widgets).forEach((id)=>{ if(!baseWidgets[id] || !zones.some(([zone])=>zone===next.widgets[id].zone)) delete next.widgets[id]; });
  if(!document.querySelector(`[data-view="${CSS.escape(next.defaultView)}"]`)) next.defaultView="home";
  return next;
}
function saveProfile(){ localStorage.setItem(storageKey,JSON.stringify(profile)); }
function loadDeviceData(){try{const saved=JSON.parse(localStorage.getItem(deviceDataKey)||"{}");sampleData.tasks=Array.isArray(saved.tasks)?saved.tasks:[];sampleData.events=Array.isArray(saved.events)?saved.events:[];}catch{sampleData.tasks=[];sampleData.events=[];}}
let dataSaveTimer;
function saveDeviceData(){localStorage.setItem(deviceDataKey,JSON.stringify({tasks:sampleData.tasks,events:sampleData.events}));if(profile.account.signedIn){clearTimeout(dataSaveTimer);dataSaveTimer=setTimeout(()=>api("/api/user-data",{method:"PUT",body:JSON.stringify({tasks:sampleData.tasks,events:sampleData.events})}).catch(()=>{}),250);}}
async function syncDeviceData(){loadDeviceData();if(!profile.account.signedIn)return;try{const remote=await api("/api/user-data");if(remote.tasks?.length||remote.events?.length){sampleData.tasks=remote.tasks||[];sampleData.events=remote.events||[];localStorage.setItem(deviceDataKey,JSON.stringify({tasks:sampleData.tasks,events:sampleData.events}));}else if(sampleData.tasks.length||sampleData.events.length)saveDeviceData();}catch{}}
async function loadCatalog(){try{const data=await api("/api/catalog");const manifests=Array.isArray(data.addOns)?data.addOns.filter(addon=>addon&&typeof addon==="object"&&addon.id):[];if(manifests.length){addOnRegistry=Object.fromEntries(manifests.map(addon=>[addon.id,addon]));Object.keys(addOnRegistry).forEach(id=>{if(!profile.addOns[id])profile.addOns[id]={installed:Boolean(addOnRegistry[id].preinstalled),enabled:Boolean(addOnRegistry[id].preinstalled),connectionStatus:addOnRegistry[id].preinstalled?"connected":"disconnected",lastSync:"",error:""};});}}catch{}}
function setMessage(message,error=false){ const el=$("storeMessage"); if(el){el.textContent=message;el.classList.toggle("is-error",error);} }
async function api(path,options={}){
  const response=await fetch(path,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.error||"Reflect OS could not complete that action.");
  return data;
}

function addOnInstalled(id){ return Boolean(profile.addOns[id]?.installed && profile.addOns[id]?.enabled); }
function connected(id){ return profile.addOns[id]?.connectionStatus==="connected"; }
function activeWidgets(){ return Object.entries(baseWidgets).filter(([,widget])=>!widget.addOn || addOnInstalled(widget.addOn)); }
function applyAvailability(){
  const map={calendar:"googleCalendar",music:"spotify",weather:"weather",homekit:"smartHome"};
  navItems.forEach((item)=>{ const required=map[item.dataset.view]; item.hidden=Boolean(required && !addOnInstalled(required)); });
  Object.entries(profileInputs).forEach(([key,input])=>{ if(!input)return; input.closest("label")?.classList.toggle("is-hidden",key.startsWith("spotify")&&!addOnInstalled("spotify")); });
}
function applyProfile(){
  const rgb=hexToRgb(profile.accentColor); document.documentElement.style.setProperty("--accent",profile.accentColor); document.documentElement.style.setProperty("--accent-rgb",rgb); document.documentElement.style.setProperty("--accent-soft",`rgba(${rgb}, .18)`);
  Object.entries(profileInputs).forEach(([key,input])=>{ if(!input)return; input.value=key==="spotifyWidgetMode"?profile.spotify.widgetMode:key==="spotifyDevice"?profile.spotify.deviceName:key==="spotifyAutoplay"?String(profile.spotify.autoplay):key==="weatherPlace"?profile.weather.place:key==="weatherLatitude"?profile.weather.latitude:key==="weatherLongitude"?profile.weather.longitude:String(profile[key]); });
  $("accountName").value=profile.account.name; $("accountEmail").value=profile.account.email;
  if($("affirmationMode"))$("affirmationMode").value=profile.affirmations.mode;
  if($("affirmationInterval"))$("affirmationInterval").value=String(profile.affirmations.interval);
  if($("affirmationCustom")&&document.activeElement!==$("affirmationCustom"))$("affirmationCustom").value=(profile.affirmations.custom||[]).join("\n");
  applyAvailability();
}
function hexToRgb(hex){ const clean=String(hex).replace("#","");const value=parseInt(clean.length===3?clean.split("").map(c=>c+c).join(""):clean,16);return Number.isNaN(value)?"157, 124, 255":`${value>>16&255}, ${value>>8&255}, ${value&255}`; }
function weatherLabel(code){if(code===0)return"Clear";if(code<=3)return"Partly cloudy";if(code<=48)return"Foggy";if(code<=57)return"Drizzle";if(code<=67)return"Rain";if(code<=77)return"Snow";if(code<=82)return"Showers";if(code<=86)return"Snow showers";return"Thunderstorms";}
function weatherIcon(code,isDay=1){if(code===0)return isDay?"☀":"☾";if(code<=3)return"☁";if(code<=48)return"≋";if(code<=67)return"☂";if(code<=77)return"✦";if(code<=82)return"☂";return"ϟ";}
function windDirection(degrees){return["N","NE","E","SE","S","SW","W","NW"][Math.round((Number(degrees)||0)/45)%8];}
function eventDisplay(event){const raw=event.start||[event.date,event.time].filter(Boolean).join("T");const date=raw?new Date(raw):null;const valid=date&&!Number.isNaN(date.valueOf());return{...event,time:event.allDay?"All day":valid?date.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}):event.time||"",day:valid?date.toLocaleDateString([], {weekday:"short",day:"numeric"}):"Upcoming"};}
function sortedEvents(){return [...sampleData.events].sort((a,b)=>String(a.start||`${a.date||"9999"}T${a.time||"23:59"}`).localeCompare(String(b.start||`${b.date||"9999"}T${b.time||"23:59"}`)));}

function renderWidget(id){
  if(id==="clock") return `<p class="time" id="timeNow">08:42</p><p class="date" id="dateNow"></p><p class="greeting" id="greeting"></p>`;
  if(id==="weather"){const current=weatherData?.current,daily=weatherData?.daily;return `<div class="weather-line"><span class="weather-icon">${weatherIcon(current?.weather_code??2,current?.is_day)}</span><span class="weather-temp">${current?Math.round(current.temperature_2m):"--"}°</span></div><p class="weather-summary">${esc(current?weatherLabel(current.weather_code):"Updating weather")}</p><p class="muted">${daily?`High ${Math.round(daily.temperature_2m_max[0])}° · Low ${Math.round(daily.temperature_2m_min[0])}°`:esc(profile.weather.place)}</p>`;}
  if(id==="calendar"){const events=sortedEvents().slice(0,3).map(eventDisplay);return `<h2>Upcoming</h2><ol class="event-list compact-list">${events.length?events.map(e=>`<li><time>${esc(e.time)}</time><span>${esc(e.title)}</span>${e.location?`<small>${esc(e.location)}</small>`:""}</li>`).join(""):`<li class="quiet-empty">No upcoming events</li>`}</ol>`;}
  if(id==="tasks") return `<h2>Today</h2><ul class="task-list compact-list">${sampleData.tasks.filter(task=>task.when==="Today").slice(0,4).map(task=>{const index=sampleData.tasks.indexOf(task);return `<li><button class="check ${task.done?"is-done":""}" data-home-task-index="${index}" aria-label="Mark ${esc(task.title)} complete"></button><span>${esc(task.title)}</span><small>${esc(task.category)}</small></li>`;}).join("")||`<li class="quiet-empty">Nothing due today</li>`}</ul>`;
  if(id==="music") return `<div class="now-playing spotify-widget"><div><p class="song">${esc(sampleData.track.title)}</p><p class="artist">${esc(sampleData.track.artist)}</p></div><div class="mini-controls"><button data-spotify-action="previous" aria-label="Previous track">‹</button><button class="play" data-spotify-action="play" aria-label="Play or pause">${sampleData.track.playing?"Ⅱ":"▶"}</button><button data-spotify-action="next" aria-label="Next track">›</button></div><div class="progress"><span style="width:${sampleData.track.progress}%"></span></div></div>`;
  if(id==="affirmations"){const pool=affirmationPool();if(!pool.length)return `<p class="affirmation-empty">Add your own affirmations in Settings.</p>`;const item=pool[affirmationIndex%pool.length];return typeof item==="string"?`<p class="affirmation-text">${esc(item)}</p>`:`<blockquote class="affirmation-quote"><p>${esc(item.t)}</p><cite>${esc(item.a)}</cite></blockquote>`;}
  if(id==="smartHome"){const items=connected("smartHome")&&homeAssistantEntities.length?homeAssistantEntities.filter(e=>["light","switch","climate","lock"].includes(e.domain)).slice(0,4).map(e=>`${e.name} · ${haValue(e)}`):sampleData.smartHome;return `<h2>Smart Home</h2><div class="smart-summary">${items.map(item=>`<p>${esc(item)}</p>`).join("")}</div>`;}
  if(id==="photos"){
    const record=photoRecords[currentPhoto%Math.max(photoRecords.length,1)];
    const url=record?photoUrls.get(record.id):"";
    return url?`<div class="photo-widget" style="--photo-brightness:${profile.photos.brightness/100}"><img src="${esc(url)}" alt="Selected mirror photo" style="object-fit:${profile.photos.fit}"></div>`:`<button class="photo-empty" type="button" data-open-photos>Add photos</button>`;
  }
  return "";
}
function renderHome(){
  layoutGrid.innerHTML=zones.map(([zone,label])=>`<div class="layout-zone" data-zone="${zone}" data-label="${label}" style="grid-area:${zone}"></div>`).join("");
  activeWidgets().filter(([id])=>profile.widgets[id]?.visible).sort((a,b)=>profile.widgets[a[0]].priority-profile.widgets[b[0]].priority).forEach(([id,widget])=>{
    const config=profile.widgets[id]; const zone=layoutGrid.querySelector(`[data-zone="${config.zone}"]`)||layoutGrid.querySelector("[data-zone='centre']"); const article=document.createElement("article");
    const isPhotoBackdrop=id==="photos"&&photoRecords.length;article.className=`mirror-widget ${isPhotoBackdrop?"photo-mirror-widget":""} ${selectedWidget===id?"is-selected":""}`; article.dataset.widget=id; article.dataset.size=config.size; article.setAttribute("aria-label",widget.label);
    const editControls=isPhotoBackdrop?`<div class="widget-edit photo-backdrop-edit"><span>Full-screen backdrop</span><button type="button" data-edit="hide">Hide</button></div>`:`<div class="widget-edit"><select data-edit="zone" aria-label="Widget zone">${zoneOptions(config.zone)}</select><select data-edit="size" aria-label="Widget size">${sizeOptions(config.size)}</select><button type="button" data-edit="hide">Hide</button></div>`;
    article.innerHTML=`<div class="widget-body">${renderWidget(id)}</div>${editControls}`; zone.append(article);
  });
  bindWidgetControls(); updateClock(); restartSlideshow(); restartAffirmations();
}
function zoneOptions(selected){return zones.map(([value,label])=>`<option value="${value}" ${value===selected?"selected":""}>${label}</option>`).join("");}
function sizeOptions(selected){return ["small","medium","large"].map(value=>`<option value="${value}" ${value===selected?"selected":""}>${value}</option>`).join("");}
function bindWidgetControls(){
  document.querySelectorAll(".mirror-widget").forEach((widget)=>{const id=widget.dataset.widget;widget.addEventListener("click",(event)=>{if(!isEditing)return;selectedWidget=id;$("editHint").textContent=`${baseWidgets[id].label} selected`;renderHome();event.stopPropagation();});widget.querySelector("[data-edit='zone']")?.addEventListener("change",(e)=>{profile.widgets[id].zone=e.target.value;saveProfile();renderHome();});widget.querySelector("[data-edit='size']")?.addEventListener("change",(e)=>{profile.widgets[id].size=e.target.value;saveProfile();renderHome();});widget.querySelector("[data-edit='hide']")?.addEventListener("click",(e)=>{profile.widgets[id].visible=false;saveProfile();renderHome();renderWidgetSettings();e.stopPropagation();});});
  document.querySelectorAll("[data-home-task-index]").forEach(button=>button.addEventListener("click",()=>{sampleData.tasks[Number(button.dataset.homeTaskIndex)].done=!sampleData.tasks[Number(button.dataset.homeTaskIndex)].done;saveDeviceData();renderHome();renderTaskPage();}));
  document.querySelectorAll("[data-spotify-action]").forEach(button=>button.addEventListener("click",e=>{runSpotifyAction(button.dataset.spotifyAction);e.stopPropagation();}));
  document.querySelector("[data-open-photos]")?.addEventListener("click",()=>{showView("addons");openAddOnDetail("photos");});
}
function renderWidgetSettings(){
  widgetSettings.innerHTML=activeWidgets().map(([id,widget])=>{const c=profile.widgets[id];const controls=id==="photos"?`<button class="widget-toggle" type="button" data-widget-toggle="${id}" aria-pressed="${c.visible}">${c.visible?"Visible":"Hidden"}</button><small>Full-screen backdrop</small>`:`<button class="widget-toggle" type="button" data-widget-toggle="${id}" aria-pressed="${c.visible}">${c.visible?"Visible":"Hidden"}</button><select data-widget-zone="${id}" aria-label="${widget.label} zone">${zoneOptions(c.zone)}</select><select data-widget-size="${id}" aria-label="${widget.label} size">${sizeOptions(c.size)}</select>`;return `<div class="widget-row"><span>${widget.label}</span><div>${controls}</div></div>`;}).join("");
  widgetSettings.querySelectorAll("[data-widget-toggle]").forEach(button=>button.addEventListener("click",()=>{const id=button.dataset.widgetToggle;profile.widgets[id].visible=!profile.widgets[id].visible;saveProfile();renderHome();renderWidgetSettings();}));
  widgetSettings.querySelectorAll("[data-widget-zone]").forEach(select=>select.addEventListener("change",()=>{profile.widgets[select.dataset.widgetZone].zone=select.value;saveProfile();renderHome();}));
  widgetSettings.querySelectorAll("[data-widget-size]").forEach(select=>select.addEventListener("change",()=>{profile.widgets[select.dataset.widgetSize].size=select.value;saveProfile();renderHome();}));
}
function affirmationPool(){
  const mode=profile.affirmations.mode;
  const custom=(profile.affirmations.custom||[]).filter(line=>String(line).trim());
  if(mode==="custom")return custom;
  if(mode==="quotes")return [...affirmationLibrary.quotes,...custom];
  if(mode==="both")return [...affirmationLibrary.affirmations,...affirmationLibrary.quotes,...custom];
  return [...affirmationLibrary.affirmations,...custom];
}
function restartAffirmations(){clearInterval(affirmationTimer);const pool=affirmationPool();if(profile.widgets.affirmations?.visible&&pool.length>1)affirmationTimer=setInterval(()=>{affirmationIndex=(affirmationIndex+1)%pool.length;const el=document.querySelector('[data-widget="affirmations"] .widget-body');if(el)el.innerHTML=renderWidget("affirmations");},Math.max(8,Number(profile.affirmations.interval)||30)*1000);}
function restartSlideshow(){clearInterval(slideshowTimer);if(profile.widgets.photos.visible&&photoRecords.length>1)slideshowTimer=setInterval(()=>{currentPhoto=profile.photos.order==="shuffle"?Math.floor(Math.random()*photoRecords.length):(currentPhoto+1)%photoRecords.length;renderHome();},profile.photos.interval*1000);}
function updateClock(){const time=$("timeNow");if(!time)return;const now=new Date();time.textContent=new Intl.DateTimeFormat("en-GB",{hour:"2-digit",minute:"2-digit",hour12:profile.clockFormat==="12"}).format(now);$("dateNow").textContent=new Intl.DateTimeFormat("en-GB",{weekday:"long",day:"numeric",month:"long"}).format(now);const hour=now.getHours();$("greeting").textContent=`${profile.greetingPrefix} ${hour<12?"morning":hour<18?"afternoon":"evening"}, ${profile.personName}`;}

function statusFor(id){const state=profile.addOns[id];if(state.error)return "Needs attention";if(!state.installed)return "Available";if(addOnRegistry[id].requiresConnection&&!connected(id))return "Connection required";return connected(id)?"Connected":"Installed";}
function renderAccount(){ $("accountStatus").textContent=profile.account.signedIn?`Signed in as ${profile.account.name}`:"Reflect account";$("accountHelp").textContent=profile.account.signedIn?"This mirror is protected and your add-ons sync to this device account.":"Create or sign in with a 4 to 8 digit device PIN. Your PIN never leaves this mirror.";$("signInAccount").textContent=profile.account.signedIn?"Update profile":"Create or sign in";$("signOutAccount").hidden=!profile.account.signedIn;$("accountPanel").classList.toggle("is-signed-in",profile.account.signedIn); }
function renderAddOns(){
  renderAccount(); const query=$("addonSearch").value.trim().toLowerCase();const category=$("addonCategory").value;
  const items=Object.values(addOnRegistry).filter(addon=>(storeTab==="discover"||profile.addOns[addon.id].installed)&&(category==="all"||addon.category===category)&&(!query||`${addon.name} ${addon.description}`.toLowerCase().includes(query)));
  addonsGrid.innerHTML=items.map(addon=>{const state=profile.addOns[addon.id];const status=statusFor(addon.id);return `<article class="addon-card ${state.installed?"is-installed":""}"><button class="addon-card-main" type="button" data-addon-detail="${addon.id}"><span class="addon-icon">${addon.icon}</span><span><small>${esc(addon.category)} · v${addon.version}</small><h2>${esc(addon.name)}</h2><p>${esc(addon.description)}</p></span></button><div class="addon-card-footer"><span class="addon-status">${status}</span><button class="store-action" type="button" data-addon-primary="${addon.id}">${state.installed?(addon.requiresConnection&&!connected(addon.id)?"Connect account":"Open"):"Install"}</button></div></article>`;}).join("")||`<p class="empty-state">No add-ons match this view.</p>`;
  addonsGrid.querySelectorAll("[data-addon-detail]").forEach(button=>button.addEventListener("click",()=>openAddOnDetail(button.dataset.addonDetail)));
  addonsGrid.querySelectorAll("[data-addon-primary]").forEach(button=>button.addEventListener("click",()=>primaryAddOnAction(button.dataset.addonPrimary)));
}
function photoManagerHtml(){return `<section class="photo-manager"><div class="photo-actions"><label class="store-action upload-action">Choose photos<input id="photoUpload" type="file" accept="image/jpeg,image/png,image/webp" multiple></label><button class="ghost-button" id="showPhotosHome" type="button" ${photoRecords.length?"":"disabled"}>${profile.widgets.photos.visible?"Hide background":"Show as background"}</button></div><p class="photo-help">JPG, PNG or WebP. Photos fill the home screen and stay on this mirror.</p><div class="photo-library">${photoRecords.map((photo,index)=>`<article class="photo-thumb"><img src="${esc(photoUrls.get(photo.id))}" alt="Photo ${index+1}"><div><button type="button" data-photo-move="up" data-photo="${photo.id}" aria-label="Move earlier">↑</button><button type="button" data-photo-move="down" data-photo="${photo.id}" aria-label="Move later">↓</button><button type="button" data-photo-delete="${photo.id}" aria-label="Delete photo">×</button></div></article>`).join("")}</div><div class="photo-settings"><label>Change every <select id="photoInterval"><option value="10">10 seconds</option><option value="15">15 seconds</option><option value="30">30 seconds</option><option value="60">1 minute</option></select></label><label>Image fit <select id="photoFit"><option value="cover">Fill screen</option><option value="contain">Show whole photo</option></select></label><label>Order <select id="photoOrder"><option value="ordered">In order</option><option value="shuffle">Shuffle</option></select></label><label>Brightness <input id="photoBrightness" type="range" min="35" max="100"></label></div></section>`;}
function openAddOnDetail(id){
  const addon=addOnRegistry[id];const state=profile.addOns[id];if(!addon)return;$("addonDetailContent").innerHTML=`<header class="detail-heading"><span class="addon-icon large">${addon.icon}</span><div><p class="eyebrow">${esc(addon.category)} · version ${addon.version}</p><h2 id="addonDetailTitle">${esc(addon.name)}</h2><p>${esc(addon.description)}</p></div></header><div class="detail-columns"><div><h3>Includes</h3><p>${esc([...addon.screens,...addon.widgets].join(" · ")||"Local module")}</p></div><div><h3>Access</h3><p>${esc(addon.permissions.join(" · "))}</p></div></div><p class="detail-status">${statusFor(id)}${state.lastSync?` · ${esc(formatSync(state.lastSync))}`:""}</p>${id==="photos"&&state.installed?photoManagerHtml():""}<footer class="detail-actions">${state.installed?`<button class="ghost-button danger" type="button" data-detail-uninstall="${id}" ${addon.preinstalled?"disabled":""}>Uninstall</button>${addon.requiresConnection?`<button class="ghost-button" type="button" data-detail-connect="${id}">${connected(id)?"Disconnect":"Connect account"}</button>`:""}<button class="store-action" type="button" data-detail-open="${id}">${id==="photos"?"Done":"Open"}</button>`:`<button class="store-action" type="button" data-detail-install="${id}">Install</button>`}</footer>`;
  if(state.error){
    const status=addonDetail.querySelector(".detail-status");
    if(status)status.insertAdjacentHTML("afterend",`<p class="integration-error">${esc(state.error)}</p>${id==="spotify"&&state.error.includes("Client ID")?`<p class="setup-note">The Reflect owner adds one Spotify Client ID in <code>reflect-os.config.json</code>. Mirror users never need developer accounts.</p>`:""}`);
  }
  bindDetail(id);if(!addonDetail.open)addonDetail.showModal();
}
function bindDetail(id){
  addonDetail.querySelector("[data-detail-install]")?.addEventListener("click",()=>installAddOn(id));addonDetail.querySelector("[data-detail-uninstall]")?.addEventListener("click",()=>uninstallAddOn(id));addonDetail.querySelector("[data-detail-connect]")?.addEventListener("click",()=>connected(id)?disconnectAddOn(id):connectAddOn(id));addonDetail.querySelector("[data-detail-open]")?.addEventListener("click",()=>{addonDetail.close();if(id!=="photos")showView(addOnRegistry[id].view);});
  $("photoUpload")?.addEventListener("change",e=>uploadPhotos(e.target.files));$("showPhotosHome")?.addEventListener("click",()=>{profile.widgets.photos.visible=!profile.widgets.photos.visible;saveProfile();renderHome();renderWidgetSettings();openAddOnDetail("photos");});
  addonDetail.querySelectorAll("[data-photo-delete]").forEach(button=>button.addEventListener("click",()=>deletePhoto(button.dataset.photoDelete)));
  addonDetail.querySelectorAll("[data-photo-move]").forEach(button=>button.addEventListener("click",()=>movePhoto(button.dataset.photo,button.dataset.photoMove)));
  [["photoInterval","interval",Number],["photoFit","fit",String],["photoOrder","order",String],["photoBrightness","brightness",Number]].forEach(([element,key,cast])=>{const input=$(element);if(!input)return;input.value=profile.photos[key];input.addEventListener("input",()=>{profile.photos[key]=cast(input.value);saveProfile();renderHome();});});
}
async function primaryAddOnAction(id){const state=profile.addOns[id];if(!state.installed)return installAddOn(id);if(addOnRegistry[id].requiresConnection&&!connected(id))return connectAddOn(id);if(id==="photos")return openAddOnDetail(id);showView(addOnRegistry[id].view);}
async function installAddOn(id){
  if(!profile.account.signedIn){addonDetail.close();setMessage("Sign in first, then install the add-on.",true);$("accountName").focus();return;}
  try{const state=await api(`/api/addons/${id}`,{method:"POST",body:"{}"});profile.addOns[id]={...profile.addOns[id],...state,error:""};const widgetId={spotify:"music",googleCalendar:"calendar",smartHome:"smartHome",photos:"photos"}[id];if(widgetId&&id!=="photos")profile.widgets[widgetId].visible=true;saveProfile();applyAvailability();renderAddOns();renderWidgetSettings();renderHome();openAddOnDetail(id);setMessage(`${addOnRegistry[id].name} installed.`);}catch(error){setMessage(error.message,true);}
}
async function uninstallAddOn(id){
  try{await api(`/api/addons/${id}`,{method:"DELETE"});profile.addOns[id]=clone(defaultAddOnState[id]);const widgetId={spotify:"music",googleCalendar:"calendar",smartHome:"smartHome",photos:"photos"}[id];if(widgetId)profile.widgets[widgetId].visible=false;saveProfile();addonDetail.close();applyAvailability();renderAddOns();renderWidgetSettings();renderHome();showView("addons");setMessage(`${addOnRegistry[id].name} uninstalled.`);}catch(error){setMessage(error.message,true);}
}
async function connectAddOn(id){
  if(!profile.account.signedIn){setMessage("Sign in to connect an account.",true);return;}
  if(id==="smartHome"){addonDetail.close();$("haDialogError").textContent="";$("haDialog").showModal();return;}
  try{const response=await fetch(`/api/integrations/${id}/connect`,{redirect:"manual"});if(response.type==="opaqueredirect"||response.status===0){location.href=`/api/integrations/${id}/connect`;return;}const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||"Connection could not start.");location.href=response.url;}catch(error){profile.addOns[id].error=error.message;saveProfile();setMessage(error.message,true);openAddOnDetail(id);}
}
async function disconnectAddOn(id){try{const state=await api(`/api/addons/${id}/disconnect`,{method:"POST",body:"{}"});profile.addOns[id]={...profile.addOns[id],...state,error:""};saveProfile();if(id==="smartHome"){homeAssistantEntities=[];renderHomeKit();renderHome();}renderAddOns();renderSpotifyPage();if(addonDetail.open)openAddOnDetail(id);}catch(error){setMessage(error.message,true);}}
function formatSync(value){const date=new Date(value);return Number.isNaN(date.valueOf())?value:`Synced ${date.toLocaleString()}`;}

function entityIsOn(e){return !["off","unavailable","unknown","closed","locked","idle","standby"].includes(String(e.state).toLowerCase());}
function haValue(e){
  if(e.domain==="climate")return e.temperature!=null?`${Math.round(e.temperature)}°`:esc(e.state);
  if(e.domain==="light"&&e.brightness!=null&&entityIsOn(e))return `${Math.round(e.brightness/255*100)}%`;
  if(e.domain==="sensor"||e.domain==="binary_sensor")return `${e.state}${e.unit?` ${e.unit}`:""}`;
  if(e.domain==="lock")return String(e.state).toLowerCase()==="locked"?"Locked":"Unlocked";
  if(e.domain==="cover")return entityIsOn(e)?"Open":"Closed";
  if(e.domain==="scene")return "Activate";
  return entityIsOn(e)?"On":"Off";
}
async function connectHomeAssistant(event){
  event.preventDefault();
  const form=event.currentTarget,data=Object.fromEntries(new FormData(form));
  $("haDialogError").textContent="";
  try{
    const state=await api("/api/integrations/homeAssistant/config",{method:"POST",body:JSON.stringify({baseUrl:data.baseUrl,token:data.token})});
    profile.addOns.smartHome={...profile.addOns.smartHome,...state,error:""};
    profile.widgets.smartHome.visible=true;saveProfile();form.reset();$("haDialog").close();
    applyAvailability();renderAddOns();renderWidgetSettings();
    await loadHomeAssistant();showView("homekit");setMessage("Home Assistant connected.");
  }catch(error){$("haDialogError").textContent=error.message;}
}
async function loadHomeAssistant(){
  if(!connected("smartHome")){renderHomeKit();return;}
  try{const data=await api("/api/homeassistant/states");homeAssistantEntities=data.entities||[];renderHomeKit();renderHome();}
  catch(error){$("homekitStatus").textContent=error.message;}
}
async function toggleEntity(id){
  const e=homeAssistantEntities.find(x=>x.id===id);if(!e)return;
  let service;
  if(e.domain==="lock")service=String(e.state).toLowerCase()==="locked"?"lock.unlock":"lock.lock";
  else if(e.domain==="cover")service=entityIsOn(e)?"cover.close_cover":"cover.open_cover";
  else if(e.domain==="scene")service="scene.turn_on";
  else service=`${e.domain}.toggle`;
  try{await api("/api/homeassistant/service",{method:"POST",body:JSON.stringify({service,data:{entity_id:id}})});setTimeout(loadHomeAssistant,500);}
  catch(error){setMessage(error.message,true);}
}
function renderHomeKit(){
  const grid=$("homekitGrid");if(!grid)return;
  const status=$("homekitStatus"),connectBtn=$("homekitConnect");
  if(connectBtn){connectBtn.hidden=false;connectBtn.textContent=connected("smartHome")?"Disconnect":"Connect Home Assistant";}
  if(!connected("smartHome")){
    if(status)status.textContent=addOnInstalled("smartHome")?"Connect your Home Assistant server":"Install Smart Home from Add-ons";
    grid.innerHTML=`<div class="homekit-empty"><p>Connect Home Assistant to control lights, climate, locks and scenes from the mirror.</p><button class="store-action" type="button" id="homekitConnectCta">Connect Home Assistant</button></div>`;
    $("homekitConnectCta")?.addEventListener("click",()=>connectAddOn("smartHome"));
    return;
  }
  if(status)status.textContent=`Home Assistant · ${homeAssistantEntities.length} device${homeAssistantEntities.length===1?"":"s"}`;
  if(!homeAssistantEntities.length){grid.innerHTML=`<div class="homekit-empty"><p>No supported devices were found in Home Assistant.</p></div>`;return;}
  const order=["light","switch","fan","climate","cover","lock","scene","binary_sensor","sensor"];
  const sorted=[...homeAssistantEntities].sort((a,b)=>order.indexOf(a.domain)-order.indexOf(b.domain));
  const interactive=new Set(["light","switch","fan","lock","cover","scene"]);
  grid.innerHTML=sorted.map(e=>{const on=entityIsOn(e),act=interactive.has(e.domain);return `<button type="button" class="ha-tile ${on?"is-on":""}" ${act?`data-ha-toggle="${esc(e.id)}"`:"disabled"}><span>${esc(e.name)}</span><strong>${esc(haValue(e))}</strong></button>`;}).join("");
  grid.querySelectorAll("[data-ha-toggle]").forEach(btn=>btn.addEventListener("click",()=>toggleEntity(btn.dataset.haToggle)));
}

function openPhotoDb(){return new Promise((resolve,reject)=>{const request=indexedDB.open("reflect-os-photos",1);request.onupgradeneeded=()=>request.result.createObjectStore("photos",{keyPath:"id"});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
function photoStore(mode="readonly"){return photoDb.transaction("photos",mode).objectStore("photos");}
async function loadPhotos(){if(!photoDb)photoDb=await openPhotoDb();const records=await new Promise((resolve,reject)=>{const r=photoStore().getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});photoUrls.forEach(URL.revokeObjectURL);photoUrls.clear();const order=new Map(profile.photos.ids.map((id,index)=>[id,index]));photoRecords=records.sort((a,b)=>(order.get(a.id)??9999)-(order.get(b.id)??9999)||a.createdAt-b.createdAt);profile.photos.ids=photoRecords.map(item=>item.id);photoRecords.forEach(item=>photoUrls.set(item.id,URL.createObjectURL(item.blob)));saveProfile();}
async function resizeImage(file){if(!["image/jpeg","image/png","image/webp"].includes(file.type))throw new Error(`${file.name} is not a supported image.`);const bitmap=await createImageBitmap(file);const max=1920;const scale=Math.min(1,max/Math.max(bitmap.width,bitmap.height));const canvas=document.createElement("canvas");canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);canvas.getContext("2d").drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error(`${file.name} could not be prepared.`)),file.type==="image/png"?"image/png":"image/jpeg",.88));}
async function uploadPhotos(files){try{for(const file of files){const blob=await resizeImage(file);const record={id:crypto.randomUUID(),name:file.name,createdAt:Date.now(),blob};await new Promise((resolve,reject)=>{const r=photoStore("readwrite").put(record);r.onsuccess=resolve;r.onerror=()=>reject(r.error);});profile.photos.ids.push(record.id);}await loadPhotos();saveProfile();setMessage(`${files.length} photo${files.length===1?"":"s"} added.`);openAddOnDetail("photos");renderHome();}catch(error){setMessage(error.message,true);openAddOnDetail("photos");}}
async function deletePhoto(id){await new Promise((resolve,reject)=>{const r=photoStore("readwrite").delete(id);r.onsuccess=resolve;r.onerror=()=>reject(r.error);});profile.photos.ids=profile.photos.ids.filter(item=>item!==id);if(!profile.photos.ids.length)profile.widgets.photos.visible=false;await loadPhotos();renderHome();renderWidgetSettings();openAddOnDetail("photos");}
async function movePhoto(id,direction){const index=profile.photos.ids.indexOf(id);const next=direction==="up"?index-1:index+1;if(index<0||next<0||next>=profile.photos.ids.length)return;[profile.photos.ids[index],profile.photos.ids[next]]=[profile.photos.ids[next],profile.photos.ids[index]];saveProfile();await loadPhotos();openAddOnDetail("photos");}

function renderCalendarPage(){const timeline=$("calendarTimeline");$("calendarStatus").textContent=connected("googleCalendar")?"Google Calendar · live":"Device calendar";const now=new Date(),endOfWeek=new Date(now);endOfWeek.setDate(now.getDate()+7);let events=sortedEvents().map(eventDisplay);if(calendarView==="day")events=events.filter(event=>{const raw=event.start||event.date;return raw&&new Date(raw).toDateString()===now.toDateString();});if(calendarView==="week")events=events.filter(event=>{const raw=event.start||event.date;return raw&&new Date(raw)<=endOfWeek;});timeline.innerHTML=events.map(event=>`<article><time>${esc(calendarView==="day"?event.time:`${event.day} · ${event.time}`)}</time><div><h3>${esc(event.title)}</h3><p>${esc(event.location||"No location")}</p></div></article>`).join("")||`<article class="empty-row"><div><h3>No events here</h3><p>Add an event or connect Google Calendar.</p></div></article>`;}
function renderTaskPage(){const filtered=sampleData.tasks.filter(task=>taskFilter==="today"?task.when==="Today"&&!task.done:taskFilter==="upcoming"?task.when==="Upcoming"&&!task.done:taskFilter==="completed"?task.done:task.category.toLowerCase()===taskFilter);$("taskList").innerHTML=filtered.map(task=>{const index=sampleData.tasks.indexOf(task);return `<li><button class="check ${task.done?"is-done":""}" data-task-index="${index}" aria-label="Toggle ${esc(task.title)}"></button><div><h3>${esc(task.title)}</h3><p>${esc(task.category)} · ${esc(task.when)}</p></div></li>`;}).join("")||"<li><div><h3>Nothing here</h3><p>This view is clear.</p></div></li>";$("taskList").querySelectorAll("[data-task-index]").forEach(button=>button.addEventListener("click",()=>{sampleData.tasks[Number(button.dataset.taskIndex)].done=!sampleData.tasks[Number(button.dataset.taskIndex)].done;saveDeviceData();renderTaskPage();renderHome();}));}
async function loadGoogleCalendar(){if(!connected("googleCalendar"))return;try{const data=await api("/api/google/calendar/events");const local=sampleData.events.filter(event=>event.source!=="google");sampleData.events=[...local,...(data.events||[]).map(event=>({...event,source:"google"}))];saveDeviceData();renderCalendarPage();renderHome();}catch(error){$("calendarStatus").textContent=error.message;}}
async function loadWeather(){try{weatherData=await api(`/api/weather?lat=${encodeURIComponent(profile.weather.latitude)}&lon=${encodeURIComponent(profile.weather.longitude)}`);renderWeatherPage();renderHome();}catch(error){$("weatherCurrent").textContent=error.message;}}
function renderWeatherPage(){if(!weatherData)return;const current=weatherData.current,daily=weatherData.daily,hourly=weatherData.hourly;$("weatherLocation").textContent=profile.weather.place;$("weatherCurrent").textContent=`${Math.round(current.temperature_2m)}° ${weatherLabel(current.weather_code)}`;$("weatherFeels").textContent=`Feels like ${Math.round(current.apparent_temperature)}° · High ${Math.round(daily.temperature_2m_max[0])}° · Low ${Math.round(daily.temperature_2m_min[0])}°`;const found=hourly.time.findIndex(time=>new Date(time)>=new Date()),start=found<0?0:found;$("weatherHourly").innerHTML=hourly.time.slice(start,start+12).map((time,index)=>{const i=start+index;return `<article><time>${index===0?"Now":new Date(time).toLocaleTimeString([], {hour:"2-digit"})}</time><span class="hourly-icon">${weatherIcon(hourly.weather_code[i],current.is_day)}</span><strong>${Math.round(hourly.temperature_2m[i])}°</strong><small>${hourly.precipitation_probability[i]??0}%</small></article>`;}).join("");const allLow=Math.min(...daily.temperature_2m_min),allHigh=Math.max(...daily.temperature_2m_max),span=Math.max(1,allHigh-allLow);$("weatherDaily").innerHTML=daily.time.slice(0,7).map((day,index)=>{const low=Math.round(daily.temperature_2m_min[index]),high=Math.round(daily.temperature_2m_max[index]),left=(low-allLow)/span*100,width=Math.max(8,(high-low)/span*100);return `<article><time>${index===0?"Today":new Date(`${day}T12:00`).toLocaleDateString([], {weekday:"long"})}</time><span>${weatherIcon(daily.weather_code[index])}</span><small>${daily.precipitation_probability_max[index]??0}%</small><strong>${low}°</strong><i><b style="--range-left:${left}%;--range-width:${width}%"></b></i><strong>${high}°</strong></article>`;}).join("");$("weatherRain").textContent=`${daily.precipitation_probability_max[0]??0}%`;$("weatherWind").textContent=`${Math.round(current.wind_speed_10m)} km/h ${windDirection(current.wind_direction_10m)}`;$("weatherSunrise").textContent=new Date(daily.sunrise[0]).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});$("weatherSunset").textContent=new Date(daily.sunset[0]).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});}
async function searchWeatherLocations(event){event.preventDefault();const query=$("weatherSearch").value.trim(),results=$("weatherLocationResults");if(query.length<2)return;results.innerHTML='<p class="empty-state">Finding places…</p>';try{const data=await api(`/api/weather/locations?q=${encodeURIComponent(query)}`);if(!data.locations?.length){results.innerHTML='<p class="empty-state">No matching places found.</p>';return;}results.innerHTML=data.locations.map((place,index)=>`<button type="button" data-weather-location="${index}"><strong>${esc(place.name)}</strong><span>${esc([place.region,place.country].filter(Boolean).join(", "))}</span></button>`).join("");results.querySelectorAll("[data-weather-location]").forEach(button=>button.addEventListener("click",()=>selectWeatherLocation(data.locations[Number(button.dataset.weatherLocation)])));}catch(error){results.innerHTML=`<p class="empty-state">${esc(error.message)}</p>`;}}
function selectWeatherLocation(place){profile.weather={place:[place.name,place.region].filter(Boolean).join(", "),latitude:place.latitude,longitude:place.longitude};saveProfile();applyProfile();$("weatherSearch").value="";$("weatherLocationResults").innerHTML="";$("weatherCurrent").textContent="Updating weather";loadWeather();}
function renderSpotifyPage(){
  const status=$("spotifyStatus"),button=$("spotifyConnect"),useDevice=$("spotifyUseDevice"),library=$("spotifyLibrary"),device=$("spotifyDeviceStatus"),art=$("spotifyArtwork");
  const needsPermission=spotifyNeedsPlaybackPermission||spotifyNeedsRecentPermission;
  status.textContent=!addOnInstalled("spotify")?"Install Spotify from Add-ons":needsPermission?"Spotify needs reconnecting":connected("spotify")?"Spotify connected":"Spotify connection required";
  button.textContent=needsPermission?"Reconnect Spotify":connected("spotify")?"Disconnect":"Connect Spotify";
  useDevice.hidden=!connected("spotify")||!spotifyDeviceId;
  $("spotifySetup").classList.toggle("is-visible",!connected("spotify")||needsPermission);
  library?.classList.toggle("is-disabled",!connected("spotify"));
  if(device)device.textContent=spotifyDeviceId?(spotifyActiveDeviceId===spotifyDeviceId?"Playing on this mirror":"Ready on this mirror"):spotifyNeedsPlaybackPermission?"Reconnect Spotify to enable playback":"Preparing Reflect OS player";
  $("spotifyTrack").textContent=sampleData.track.title;$("spotifyArtist").textContent=sampleData.track.artist;$("spotifyMeta").textContent=`${sampleData.track.album} · ${profile.spotify.deviceName}`;$("spotifyPlay").textContent=sampleData.track.playing?"Ⅱ":"▶";$("spotifyProgress").style.width=`${sampleData.track.progress}%`;
  if(art){if(sampleData.track.artwork){art.src=sampleData.track.artwork;art.hidden=false;}else{art.removeAttribute("src");art.hidden=true;}}
}
async function loadSpotify(){if(!connected("spotify"))return;try{const playback=await api("/api/spotify/player");spotifyActiveDeviceId=playback.device?.id||"";if(playback.item){sampleData.track={uri:playback.item.uri||"",title:playback.item.name,artist:playback.item.artists?.map(a=>a.name).join(", ")||"Spotify",album:playback.item.album?.name||"Spotify",artwork:playback.item.album?.images?.at(-1)?.url||"",progress:playback.item.duration_ms?Math.round(playback.progress_ms/playback.item.duration_ms*100):0,playing:Boolean(playback.is_playing)};profile.spotify.deviceName=playback.device?.name||profile.spotify.deviceName;saveProfile();}renderSpotifyPage();renderHome();}catch(error){$("spotifySetupText").textContent=error.message;}}
async function spotifySdkToken(){try{const data=await api("/api/spotify/sdk-token");spotifyNeedsPlaybackPermission=false;return data.access_token;}catch(error){spotifyNeedsPlaybackPermission=error.message.includes("Reconnect Spotify");$("spotifySetupText").textContent=error.message;renderSpotifyPage();throw error;}}
function ensureSpotifySdk(){
  if(!connected("spotify")||spotifyPlayer||spotifySdkLoading)return;spotifySdkLoading=true;window.onSpotifyWebPlaybackSDKReady=initSpotifyPlayer;
  if(window.Spotify){initSpotifyPlayer();return;}const script=document.createElement("script");script.src="https://sdk.scdn.co/spotify-player.js";script.async=true;script.onerror=()=>{$("spotifyDeviceStatus").textContent="Spotify player could not load";spotifySdkLoading=false;};document.head.append(script);
}
async function initSpotifyPlayer(){
  if(spotifyPlayer||!window.Spotify)return;try{await spotifySdkToken();}catch{spotifySdkLoading=false;return;}
  spotifyPlayer=new Spotify.Player({name:"Reflect OS Mirror",getOAuthToken:async(callback)=>{try{callback(await spotifySdkToken());}catch{}},volume:Number($("spotifyVolume").value)/100,enableMediaSession:true});
  spotifyPlayer.addListener("ready",({device_id})=>{spotifyDeviceId=device_id;profile.spotify.deviceName="Reflect OS Mirror";saveProfile();renderSpotifyPage();});
  spotifyPlayer.addListener("not_ready",()=>{spotifyDeviceId="";renderSpotifyPage();});
  spotifyPlayer.addListener("player_state_changed",(state)=>{if(!state)return;const track=state.track_window.current_track;spotifyActiveDeviceId=spotifyDeviceId;sampleData.track={uri:track.uri||"",title:track.name,artist:track.artists?.map(a=>a.name).join(", ")||"Spotify",album:track.album?.name||"Spotify",artwork:track.album?.images?.at(-1)?.url||"",progress:state.duration?Math.round(state.position/state.duration*100):0,playing:!state.paused};renderSpotifyPage();renderHome();});
  ["initialization_error","authentication_error","account_error","playback_error"].forEach(event=>spotifyPlayer.addListener(event,({message})=>{$("spotifySetupText").textContent=event==="account_error"?"Playing through Reflect OS requires Spotify Premium.":message;$("spotifySetup").classList.add("is-visible");}));
  await spotifyPlayer.connect();spotifySdkLoading=false;
}
function renderSpotifyResults(){const results=$("spotifyResults");if(!spotifySearchResults.length){results.innerHTML='<p class="empty-state">No tracks found.</p>';return;}results.innerHTML=spotifySearchResults.map((track,index)=>`<button class="spotify-result" type="button" data-spotify-track="${index}"><span class="result-title">${esc(track.name)}</span><span>${esc(track.artists)}</span><small>${esc(track.album)}</small></button>`).join("");results.querySelectorAll("[data-spotify-track]").forEach(button=>button.addEventListener("click",()=>playSpotifyTrack(spotifySearchResults[Number(button.dataset.spotifyTrack)])));}
async function searchSpotify(event){event.preventDefault();const query=$("spotifySearch").value.trim();if(!query)return;$("spotifyResults").innerHTML='<p class="empty-state">Searching Spotify…</p>';try{const data=await api(`/api/spotify/search?q=${encodeURIComponent(query)}`);spotifySearchResults=data.tracks||[];renderSpotifyResults();}catch(error){$("spotifyResults").innerHTML=`<p class="empty-state">${esc(error.message)}</p>`;}}
function renderSpotifyRecent(){const recent=$("spotifyRecent");if(!recent)return;if(!spotifyRecentTracks.length){recent.innerHTML='<p class="empty-state">No recently played tracks yet.</p>';return;}recent.innerHTML=spotifyRecentTracks.slice(0,8).map((track,index)=>`<button class="spotify-result" type="button" data-spotify-recent="${index}"><span class="result-title">${esc(track.name)}</span><span>${esc(track.artists)}</span><small>${esc(track.album)}</small></button>`).join("");recent.querySelectorAll("[data-spotify-recent]").forEach(button=>button.addEventListener("click",()=>playSpotifyTrack(spotifyRecentTracks[Number(button.dataset.spotifyRecent)])));}
async function loadSpotifyRecent(){if(!connected("spotify"))return;const recent=$("spotifyRecent");if(recent)recent.innerHTML='<p class="empty-state">Loading recent tracks…</p>';try{const data=await api("/api/spotify/recent");spotifyRecentTracks=data.tracks||[];spotifyNeedsRecentPermission=false;renderSpotifyRecent();renderSpotifyPage();}catch(error){spotifyNeedsRecentPermission=error.message.includes("Reconnect Spotify");if(recent)recent.innerHTML=`<p class="empty-state">${esc(error.message)}</p>`;if(spotifyNeedsRecentPermission)$("spotifySetupText").textContent=error.message;renderSpotifyPage();}}
function waitForSpotifyDevice(timeout=12000){ensureSpotifySdk();return new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(spotifyPlayer&&spotifyDeviceId){clearInterval(timer);resolve();}else if(Date.now()-started>=timeout){clearInterval(timer);reject(new Error("The Spotify player did not become ready. Reopen Reflect OS and try again."));}},150);});}
async function playSpotifyTrack(track){if(!track?.uri)return;$("spotifyDeviceStatus").textContent=`Starting ${track.name}`;try{if(spotifyPlayer)await spotifyPlayer.activateElement();await waitForSpotifyDevice();await spotifyPlayer.activateElement();await api("/api/spotify/player/play",{method:"POST",body:JSON.stringify({uri:track.uri,deviceId:spotifyDeviceId})});spotifyActiveDeviceId=spotifyDeviceId;sampleData.track={...track,artist:track.artists,progress:0,playing:true};renderSpotifyPage();renderHome();setTimeout(loadSpotify,500);}catch(error){$("spotifyDeviceStatus").textContent=error.message;}}
async function loadSpotifyPlaylists(){
  if(!connected("spotify"))return;
  try{const data=await api("/api/spotify/playlists");spotifyPlaylists=data.playlists||[];renderSpotifyPlaylists();}
  catch{}
}
function renderSpotifyPlaylists(){
  const list=$("spotifyPlaylists");if(!list)return;
  if(!connected("spotify")){list.innerHTML='<li class="playlist-empty">Connect Spotify to see your playlists.</li>';return;}
  if(!spotifyPlaylists.length){list.innerHTML='<li class="playlist-empty">No playlists found yet.</li>';return;}
  list.innerHTML=spotifyPlaylists.map((p,i)=>`<li><button type="button" class="playlist-item ${p.uri===profile.spotify.playlistUri?"is-default":""}" data-playlist="${i}"><span>${esc(p.name)}</span><small>${p.tracks} track${p.tracks===1?"":"s"}${p.uri===profile.spotify.playlistUri?" · default":""}</small></button></li>`).join("");
  list.querySelectorAll("[data-playlist]").forEach(btn=>btn.addEventListener("click",()=>playSpotifyContext(spotifyPlaylists[Number(btn.dataset.playlist)].uri)));
}
async function playSpotifyContext(uri){
  if(!uri)return;
  $("spotifyDeviceStatus").textContent="Starting music on this mirror";
  try{
    if(spotifyPlayer)await spotifyPlayer.activateElement();
    await waitForSpotifyDevice();
    await spotifyPlayer.activateElement();
    await api("/api/spotify/player/play",{method:"POST",body:JSON.stringify({contextUri:uri,deviceId:spotifyDeviceId})});
    spotifyActiveDeviceId=spotifyDeviceId;profile.spotify.deviceName="Reflect OS Mirror";profile.spotify.playlist=spotifyPlaylists.find(p=>p.uri===uri)?.name||profile.spotify.playlist;profile.spotify.playlistUri=uri;saveProfile();
    renderSpotifyPlaylists();setTimeout(loadSpotify,600);
  }catch(error){$("spotifyDeviceStatus").textContent=error.message;}
}
async function playSpotifyHere(){try{$("spotifyDeviceStatus").textContent="Preparing the player on this mirror";if(spotifyPlayer)await spotifyPlayer.activateElement();await waitForSpotifyDevice();await spotifyPlayer.activateElement();await api("/api/spotify/player/transfer",{method:"POST",body:JSON.stringify({deviceId:spotifyDeviceId})});spotifyActiveDeviceId=spotifyDeviceId;profile.spotify.deviceName="Reflect OS Mirror";saveProfile();$("spotifyDeviceStatus").textContent="Playing through this mirror";setTimeout(loadSpotify,500);}catch(error){$("spotifyDeviceStatus").textContent=error.message;}}
async function runSpotifyAction(action){if(!connected("spotify")){showView("addons");openAddOnDetail("spotify");return;}if(action==="play"&&spotifyActiveDeviceId!==spotifyDeviceId){if(sampleData.track.uri&&spotifyActiveDeviceId)return playSpotifyHere();const defaultUri=profile.spotify.playlistUri||spotifyPlaylists[0]?.uri;if(defaultUri)return playSpotifyContext(defaultUri);if(spotifyRecentTracks[0])return playSpotifyTrack(spotifyRecentTracks[0]);}try{await waitForSpotifyDevice();await spotifyPlayer.activateElement();if(action==="play")await spotifyPlayer.togglePlay();else if(action==="next")await spotifyPlayer.nextTrack();else await spotifyPlayer.previousTrack();setTimeout(loadSpotify,350);}catch(error){$("spotifyDeviceStatus").textContent=error.message;}}

function showView(name,reveal=true){const required={calendar:"googleCalendar",music:"spotify",weather:"weather",homekit:"smartHome"}[name];if(required&&!addOnInstalled(required)){name="addons";setMessage(`Install ${addOnRegistry[required].name} to open that screen.`);}views.forEach(view=>view.classList.toggle("is-active",view.id===`view-${name}`));navItems.forEach(item=>{const active=item.dataset.view===name;item.classList.toggle("is-active",active);item.toggleAttribute("aria-current",active);});if(name==="music"){ensureSpotifySdk();loadSpotifyPlaylists();}if(name==="homekit")loadHomeAssistant();if(reveal)showNav();}
function showNav(){nav.classList.add("is-visible");clearTimeout(hideTimer);hideTimer=setTimeout(()=>{if(!isEditing)nav.classList.remove("is-visible");},profile.navTimeout);}
function setEditing(value){isEditing=value;document.body.classList.toggle("is-editing",value);if(!value)selectedWidget="clock";renderHome();}

function openItemDialog(kind){const dialog=$("itemDialog"),fields=$("itemFields"),today=new Date().toISOString().slice(0,10);dialog.dataset.kind=kind;$("itemDialogEyebrow").textContent=kind==="task"?"Focus list":"Device calendar";$("itemDialogTitle").textContent=kind==="task"?"Add task":"Add event";fields.innerHTML=kind==="task"?`<label><span>Task</span><input name="title" required maxlength="80" autofocus></label><label><span>Category</span><select name="category"><option>Home</option><option>Work</option><option>Health</option><option>Personal</option></select></label><label><span>When</span><select name="when"><option>Today</option><option>Upcoming</option></select></label>`:`<label><span>Event</span><input name="title" required maxlength="80" autofocus></label><label><span>Date</span><input name="date" type="date" value="${today}" required></label><label><span>Time</span><input name="time" type="time" value="09:00" required></label><label><span>Location</span><input name="location" maxlength="80"></label>`;dialog.showModal();setTimeout(()=>fields.querySelector("input")?.focus(),0);}
function addItem(event){event.preventDefault();const dialog=$("itemDialog"),data=Object.fromEntries(new FormData(event.currentTarget));if(dialog.dataset.kind==="task")sampleData.tasks.unshift({id:crypto.randomUUID(),title:data.title.trim(),category:data.category,when:data.when,done:false});else sampleData.events.push({id:crypto.randomUUID(),title:data.title.trim(),date:data.date,time:data.time,location:data.location.trim(),source:"device"});saveDeviceData();dialog.close();renderTaskPage();renderCalendarPage();renderHome();}
async function signIn(){try{const data=await api("/api/session",{method:"POST",body:JSON.stringify({name:$("accountName").value,email:$("accountEmail").value,pin:$("accountPin").value})});profile.account={signedIn:true,...data.account};$("accountPin").value="";profile.personName=data.account.name.split(" ")[0];Object.keys(addOnRegistry).forEach(id=>{if(data.account.addOns?.[id])profile.addOns[id]={...profile.addOns[id],...data.account.addOns[id]};});saveProfile();await syncDeviceData();applyProfile();renderAddOns();renderHome();renderCalendarPage();renderTaskPage();renderWidgetSettings();loadGoogleCalendar();setMessage("Signed in securely on this mirror.");}catch(error){setMessage(error.message,true);}}
async function signOut(){try{await api("/api/session",{method:"DELETE"});profile.account.signedIn=false;profile.account.id="";Object.keys(addOnRegistry).forEach(id=>{if(addOnRegistry[id].requiresConnection&&profile.addOns[id])profile.addOns[id].connectionStatus="disconnected";});spotifyDeviceId="";spotifyActiveDeviceId="";spotifyRecentTracks=[];spotifyNeedsPlaybackPermission=false;spotifyNeedsRecentPermission=false;if(spotifyPlayer){spotifyPlayer.disconnect();spotifyPlayer=null;}saveProfile();applyAvailability();renderAddOns();renderSpotifyPage();renderSpotifyRecent();renderHome();setMessage("Signed out of this mirror.");}catch(error){setMessage(error.message,true);}}
async function restoreSession(){try{const data=await api("/api/session");if(data.signedIn){profile.account={signedIn:true,...data.account};Object.keys(addOnRegistry).forEach(id=>{if(data.account.addOns?.[id])profile.addOns[id]={...profile.addOns[id],...data.account.addOns[id]};});}else profile.account.signedIn=false;saveProfile();}catch{profile.account.signedIn=false;}}

Object.entries(profileInputs).forEach(([key,input])=>input?.addEventListener("input",()=>{if(key==="spotifyWidgetMode")profile.spotify.widgetMode=input.value;else if(key==="spotifyDevice")profile.spotify.deviceName=input.value;else if(key==="spotifyAutoplay")profile.spotify.autoplay=input.value==="true";else if(key!=="weatherPlace")profile[key]=key==="navTimeout"?Number(input.value):input.value;saveProfile();applyProfile();renderHome();renderSpotifyPage();}));
navItems.forEach(item=>item.addEventListener("click",()=>showView(item.dataset.view)));
document.querySelectorAll("[data-store-tab]").forEach(button=>button.addEventListener("click",()=>{storeTab=button.dataset.storeTab;document.querySelectorAll("[data-store-tab]").forEach(item=>item.classList.toggle("is-selected",item===button));renderAddOns();}));
$("addonSearch").addEventListener("input",renderAddOns);$("addonCategory").addEventListener("change",renderAddOns);$("closeAddonDetail").addEventListener("click",()=>addonDetail.close());$("signInAccount").addEventListener("click",signIn);$("signOutAccount").addEventListener("click",signOut);
$("spotifyConnect").addEventListener("click",()=>connected("spotify")&&!spotifyNeedsPlaybackPermission&&!spotifyNeedsRecentPermission?disconnectAddOn("spotify"):connectAddOn("spotify"));$("spotifyOpenAddons").addEventListener("click",()=>{showView("addons");openAddOnDetail("spotify");});$("spotifyPrevious").addEventListener("click",()=>runSpotifyAction("previous"));$("spotifyNext").addEventListener("click",()=>runSpotifyAction("next"));$("spotifyPlay").addEventListener("click",()=>runSpotifyAction("play"));
$("spotifyUseDevice").addEventListener("click",playSpotifyHere);
$("spotifySearchForm")?.addEventListener("submit",searchSpotify);$("spotifyRefreshRecent")?.addEventListener("click",loadSpotifyRecent);$("spotifyVolume")?.addEventListener("input",event=>{if(spotifyPlayer)spotifyPlayer.setVolume(Number(event.target.value)/100);});
$("weatherSearchForm")?.addEventListener("submit",searchWeatherLocations);
document.querySelectorAll("[data-calendar-view]").forEach(button=>button.addEventListener("click",()=>{calendarView=button.dataset.calendarView;document.querySelectorAll("[data-calendar-view]").forEach(item=>item.classList.toggle("is-selected",item===button));renderCalendarPage();}));
document.querySelectorAll("[data-task-filter]").forEach(button=>button.addEventListener("click",()=>{taskFilter=button.dataset.taskFilter;document.querySelectorAll("[data-task-filter]").forEach(item=>item.classList.toggle("is-selected",item===button));renderTaskPage();}));
$("addEvent").addEventListener("click",()=>openItemDialog("event"));$("addTask").addEventListener("click",()=>openItemDialog("task"));$("itemForm").addEventListener("submit",addItem);$("cancelItem").addEventListener("click",()=>$("itemDialog").close());
$("affirmationMode")?.addEventListener("change",()=>{affirmationIndex=0;profile.affirmations.mode=$("affirmationMode").value;saveProfile();renderHome();});
$("affirmationInterval")?.addEventListener("change",()=>{profile.affirmations.interval=Number($("affirmationInterval").value);saveProfile();restartAffirmations();});
$("affirmationCustom")?.addEventListener("input",()=>{affirmationIndex=0;profile.affirmations.custom=$("affirmationCustom").value.split("\n").map(line=>line.trim()).filter(Boolean);saveProfile();renderHome();});
$("haForm")?.addEventListener("submit",connectHomeAssistant);$("haCancel")?.addEventListener("click",()=>$("haDialog").close());$("homekitConnect")?.addEventListener("click",()=>connected("smartHome")?disconnectAddOn("smartHome"):connectAddOn("smartHome"));
document.querySelectorAll("[data-home-device]").forEach(button=>button.addEventListener("click",()=>button.classList.toggle("is-active")));
$("saveLayout").addEventListener("click",()=>setEditing(false));$("resetLayout").addEventListener("click",()=>{const account=profile.account,addOns=profile.addOns,photos=profile.photos;profile=clone(defaultProfile);profile.account=account;profile.addOns=addOns;profile.photos=photos;saveProfile();applyProfile();renderHome();renderWidgetSettings();});
document.addEventListener("mousemove",showNav);document.addEventListener("click",showNav);document.addEventListener("touchstart",event=>{touchStartX=event.changedTouches[0].clientX;longPressTimer=setTimeout(()=>setEditing(true),760);showNav();},{passive:true});document.addEventListener("touchend",event=>{clearTimeout(longPressTimer);const delta=event.changedTouches[0].clientX-touchStartX;if(Math.abs(delta)<70||isEditing)return;const visible=[...navItems].filter(item=>!item.hidden);const active=visible.findIndex(item=>item.classList.contains("is-active"));showView(visible[Math.max(0,Math.min(visible.length-1,active+(delta<0?1:-1)))].dataset.view);},{passive:true});
document.addEventListener("keydown",event=>{if(event.target.matches("input,select,textarea"))return;if(event.key==="Escape"){if(addonDetail.open)addonDetail.close();else setEditing(false);return;}if(event.key.toLowerCase()==="e"){setEditing(!isEditing);return;}const view={h:"home",c:"calendar",t:"tasks",m:"music",w:"weather",s:"homekit",a:"addons",",":"settings"}[event.key.toLowerCase()];if(view)showView(view);});

let bootVersion=null;
async function watchForUpdates(){
  try{const health=await api("/api/health");
    if(!health.version)return;
    const label=$("appVersion");if(label)label.textContent=`v${health.version}`;
    if(bootVersion===null){bootVersion=health.version;return;}
    if(health.version!==bootVersion){
      if(isEditing||sampleData.track.playing)return; // never interrupt editing or playback; apply on a later idle poll
      location.reload();
    }
  }catch{}
}

const setupKey="reflect-os-setup-complete-v1";
let setupStep=0,setupLocation=null,setupError="";
const setupSteps=["welcome","location","account"];
function needsSetup(){return !localStorage.getItem(setupKey)&&!profile.account.signedIn;}
function openSetup(){setupStep=0;setupLocation=null;setupError="";renderSetup();const d=$("setupWizard");if(!d.open)d.showModal();}
function completeSetup(){localStorage.setItem(setupKey,"1");$("setupWizard").close();}
function renderSetup(){
  const body=$("setupBody"),eyebrow=$("setupEyebrow"),title=$("setupTitle"),step=setupSteps[setupStep];
  $("setupBack").hidden=setupStep===0;
  $("setupProgress").innerHTML=setupSteps.map((_,i)=>`<span class="${i===setupStep?"is-active":""}"></span>`).join("");
  if(step==="welcome"){
    eyebrow.textContent="Welcome";title.textContent="Make this mirror yours";$("setupNext").textContent="Continue";
    body.innerHTML=`<p class="setup-help">A few quick choices and your mirror is ready.</p>
      <label class="setup-field"><span>Your name</span><input id="setupName" autocomplete="given-name" value="${esc(profile.personName==="Will"?"":profile.personName)}" placeholder="e.g. Alex"></label>
      <label class="setup-field"><span>Greeting</span><input id="setupGreeting" value="${esc(profile.greetingPrefix)}"></label>
      <label class="setup-field"><span>Clock</span><select id="setupClock"><option value="24"${profile.clockFormat==="24"?" selected":""}>24 hour</option><option value="12"${profile.clockFormat==="12"?" selected":""}>12 hour</option></select></label>`;
  } else if(step==="location"){
    eyebrow.textContent="Weather";title.textContent="Where are you?";$("setupNext").textContent="Continue";
    body.innerHTML=`<p class="setup-help">Used for local weather. You can change it later in Settings.</p>
      <form class="weather-search" id="setupLocationForm" role="search"><input id="setupLocationInput" type="search" placeholder="Town or city" autocomplete="off"><button class="store-action" type="submit">Search</button></form>
      <div class="setup-location-results" id="setupLocationResults" aria-live="polite">${setupLocation?`<p class="setup-selected">Selected: <strong>${esc(setupLocation.label)}</strong></p>`:`<p class="setup-help">Currently: ${esc(profile.weather.place)}</p>`}</div>`;
    $("setupLocationForm").addEventListener("submit",searchSetupLocations);
  } else {
    eyebrow.textContent="Account";title.textContent="Protect this mirror";$("setupNext").textContent="Finish";
    body.innerHTML=`<p class="setup-help">Create a device account so your add-ons and layout are saved. Your PIN stays on this mirror.</p>
      <label class="setup-field"><span>Name</span><input id="setupAccountName" autocomplete="name" value="${esc($("setupName")?.value||(profile.personName==="Will"?"":profile.personName))}"></label>
      <label class="setup-field"><span>Email</span><input id="setupAccountEmail" inputmode="email" autocomplete="email" placeholder="you@example.com"></label>
      <label class="setup-field"><span>PIN (4–8 digits)</span><input id="setupAccountPin" type="password" inputmode="numeric" pattern="[0-9]*" minlength="4" maxlength="8" placeholder="••••"></label>
      ${setupError?`<p class="ha-error">${esc(setupError)}</p>`:""}`;
  }
}
async function searchSetupLocations(event){
  event.preventDefault();const query=$("setupLocationInput").value.trim(),results=$("setupLocationResults");
  if(query.length<2)return;results.innerHTML='<p class="setup-help">Finding places…</p>';
  try{const data=await api(`/api/weather/locations?q=${encodeURIComponent(query)}`);
    if(!data.locations?.length){results.innerHTML='<p class="setup-help">No matching places found.</p>';return;}
    results.innerHTML=data.locations.map((place,index)=>`<button type="button" class="setup-location-option" data-setup-location="${index}"><strong>${esc(place.name)}</strong><span>${esc([place.region,place.country].filter(Boolean).join(", "))}</span></button>`).join("");
    results.querySelectorAll("[data-setup-location]").forEach(button=>button.addEventListener("click",()=>{const place=data.locations[Number(button.dataset.setupLocation)];setupLocation={label:[place.name,place.region].filter(Boolean).join(", "),place};results.innerHTML=`<p class="setup-selected">Selected: <strong>${esc(setupLocation.label)}</strong></p>`;}));
  }catch(error){results.innerHTML=`<p class="setup-help">${esc(error.message)}</p>`;}
}
function applyWelcomeStep(){
  const name=$("setupName")?.value.trim();if(name)profile.personName=name;
  const greeting=$("setupGreeting")?.value.trim();if(greeting)profile.greetingPrefix=greeting;
  const clock=$("setupClock")?.value;if(clock)profile.clockFormat=clock;
  saveProfile();applyProfile();updateClock();
}
function applyLocationStep(){if(setupLocation){const p=setupLocation.place;profile.weather={place:setupLocation.label,latitude:p.latitude,longitude:p.longitude};saveProfile();applyProfile();loadWeather();}}
async function setupAdvance(){
  const step=setupSteps[setupStep];
  if(step==="welcome"){applyWelcomeStep();setupStep=1;renderSetup();return;}
  if(step==="location"){applyLocationStep();setupStep=2;renderSetup();return;}
  // account step
  setupError="";
  const name=$("setupAccountName").value.trim(),email=$("setupAccountEmail").value.trim(),pin=$("setupAccountPin").value.trim();
  if(!name||!/^\S+@\S+\.\S+$/.test(email)||!/^\d{4,8}$/.test(pin)){setupError="Enter your name, a valid email and a 4–8 digit PIN.";renderSetup();return;}
  $("accountName").value=name;$("accountEmail").value=email;$("accountPin").value=pin;
  await signIn();
  if(!profile.account.signedIn){setupError="That PIN is not correct for this email, or the account is locked. Try again.";renderSetup();return;}
  completeSetup();showView(profile.defaultView,false);
}
$("setupNext")?.addEventListener("click",setupAdvance);
$("setupBack")?.addEventListener("click",()=>{if(setupStep>0){setupStep-=1;setupError="";renderSetup();}});
$("setupSkip")?.addEventListener("click",completeSetup);

async function boot(){loadDeviceData();await loadCatalog();await restoreSession();await syncDeviceData();try{await loadPhotos();}catch(error){setMessage(`Photos are unavailable: ${error.message}`,true);}applyProfile();renderHome();renderWidgetSettings();renderAddOns();renderSpotifyPage();renderSpotifyRecent();renderCalendarPage();renderTaskPage();renderWeatherPage();renderHomeKit();const params=new URLSearchParams(location.search);if(params.get("status")==="connected"){const id=params.get("integration");if(profile.addOns[id]){profile.addOns[id].connectionStatus="connected";profile.addOns[id].error="";spotifyNeedsPlaybackPermission=false;spotifyNeedsRecentPermission=false;saveProfile();setMessage(`${addOnRegistry[id].name} connected.`);}history.replaceState({},"",location.pathname);}else if(params.get("status")==="failed"){setMessage("The account connection was not completed.",true);history.replaceState({},"",location.pathname);}showView(profile.defaultView,false);if(needsSetup())openSetup();loadWeather();loadGoogleCalendar();loadSpotify();loadSpotifyRecent();loadSpotifyPlaylists();loadHomeAssistant();ensureSpotifySdk();setInterval(updateClock,1000);setInterval(loadWeather,900000);setInterval(loadGoogleCalendar,300000);setInterval(loadSpotify,30000);setInterval(loadHomeAssistant,30000);watchForUpdates();setInterval(watchForUpdates,120000);}
boot();
