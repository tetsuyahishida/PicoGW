const DEVICE_MULTICAST_INTERVAL = 60*1000 ;
const GET_TIMEOUT = 60 * 1000 ;
const MY_EOJ = [0x05,0xff,0x01] ;
const LOCALE = 'JP' ;

var VERSION ;

// If you add 'makercode' entry to localstorage.json (as a number), the number is
// loaded to this MAKER_CODE variable.
var MAKER_CODE = 0 ;

var fs = require('fs');
var EL = require('echonet-lite');
var ProcConverter = require( './proc_converter.js') ;


var pluginInterface ;
var log = console.log ;
var localStorage ;

var macs = {} ;
function savemac(){ localStorage.setItem('macs',macs) ; }

/* macs entry format:
key:macaddress
value: {
	ip : LAST_AVAILABLE_IP_ADDRESS
	, active:true (at least one message is received since last boot.)|false (otherwise)
	, nodeprofile : {
		 version: VERSION(0x82) , id: ID(0x83) ,date: PRODUCTION_DATE(0x8e / optional))
	}
	, devices :{
		DEVICE_ID (etc. DomesticHomeAirConditioner_1) : {
			  eoj : object identifier (eg. 0x013001)
			, active :  true (the device is registered to the controller)
						| false (the user deleted this device)
						| null (the device is not registered yet)
			, location : 0x81
			, error : 0x88
			, date : PRODUCTION_DATE (0x8e / optional)
			, worktime : cumulated working time (0x9a / optional)
			, propertymap : [] array of available properties
			, options : {} device specific information extracted from devices DB
		},
	}
	, eoj_id_map : {	// EOJ (eg.013001) to DEVICE_ID (eg. DomesticHomeAirConditioner_1) mapping
		EOJ: DEVICE_ID,
	}
}
*/

function expandDeviceIdFromPossiblyRegExpDeviceId(device_id_with_regexp){
	var re = [] ;
	var regexp = new RegExp(device_id_with_regexp) ;
	for( var mac in macs ){
		for( var devid in macs[mac].devices ){
			if( devid.match(regexp) ){
				re.push(devid) ;
			}
		}
	}

	return re ;
}

function getMacFromDeviceId(device_id){
	for( var mac in macs ){
		for( var devid in macs[mac].devices ){
			if( devid == device_id ){
				return mac ;
			}
		}
	}
	return undefined ;
}

var ELDB = {} ;

exports.init = function(pi,_VERSION){
	VERSION = _VERSION ;
	pluginInterface = pi ;
	log = pluginInterface.log ;
	localStorage = pluginInterface.localStorage ;
	macs = localStorage.getItem('macs',{}) ;
	MAKER_CODE = localStorage.getItem('makercode',MAKER_CODE) ;

	// Reset states
	for( var mac in macs ){
		macs[mac].active = false ;
		for( var devid in macs[mac].devices )
			macs[mac].devices[devid].active = false ;
	}

	pluginInterface.setNetIDCallbacks({
		 onNewIDFoundCallback : function(newid,newip){
		 	//log('onNewIDFoundCallback:'+JSON.stringify(arguments)) ;
		 }
		,onIPAddressLostCallback : function(id,lostip){
		 	//log('onIPAddressLostCallback:'+JSON.stringify(arguments)) ;
		}
		,onIPAddressRecoveredCallback : function(id,recoveredip){
		 	//log('onIPAddressRecoveredCallback:'+JSON.stringify(arguments)) ;
		}
		,onIPAddressChangedCallback : function(id,oldip,newip){
		 	//log('onIPAddressChangedCallback:'+JSON.stringify(arguments)) ;
		}
	}) ;

	// Initialize echonet lite
	EL.Node_details['8a'][2] = MAKER_CODE ;

	// Construct ELDB
	// Load database with minimization / resource embedding
	{
		var data = JSON.parse( fs.readFileSync(pluginInterface.getpath()+'all_Body.json','utf-8')) ;
		var names = JSON.parse( fs.readFileSync(pluginInterface.getpath()+'all_'+LOCALE+'.json','utf-8')).names ;
		for( var objname in data.elObjects ){
			var objnamelc = objname.substring(2).toLowerCase() ;
			var eoj = data.elObjects[objname] ;
			var minimize_obj
				= {objectType:eoj.objectType , objectName:names[eoj.objectName] , epcs:{}} ;

			for( var epcname in eoj.epcs ){
				var edtconvs = undefined ;
				try {
					edtconvs = ProcConverter.eojs[objnamelc][epcname.substring(2).toLowerCase()] ;
				} catch(e){}
				minimize_obj.epcs[epcname.substring(2).toLowerCase()] = {
					epcType : eoj.epcs[epcname].epcType
					, epcName : names[eoj.epcs[epcname].epcName]
					, epcDoc : eoj.epcs[epcname].doc
					, edtConvFuncs : edtconvs
				} ;
			}
			ELDB[objnamelc] = minimize_obj ;
		}
		delete data ;
		delete names ;
	}
	// fs.writeFileSync(pluginInterface.getpath()+'minimized.json',JSON.stringify(ELDB ,null,"\t")) ;

	// Replace the original function	
	// ネットワーク内のEL機器全体情報を更新する，受信したら勝手に実行される
	EL.renewFacilities = function( ip, els ) {
		//console.dir(els) ;
		pluginInterface.getNetIDFromIPv4Address(ip).then(mac=>{
			try {
				const seoj = els.SEOJ.substring(0,4) ;
				var epcList = EL.parseDetail( els.OPC, els.DETAIL );

				if( macs[mac] == undefined ){
					macs[mac] = {ip:ip,active:true,nodeprofile:{},devices:{},eoj_id_map:{}} ;
				} else {
					macs[mac].active = true ;
					macs[mac].ip = ip ; // ip may be changed
				}

				var mm = macs[mac] ;

				// 新規obj
				if( seoj != '0ef0' ){
					if( mm.eoj_id_map[els.SEOJ] != undefined ) {
						// Already defined device
						var dev = mm.devices[ mm.eoj_id_map[els.SEOJ] ] ;
						if( dev.active !== true ){	// First time since last boot
							registerExistingDevice(mm.eoj_id_map[els.SEOJ]) ;
							// Request for property map
							EL.getPropertyMaps( ip, EL.toHexArray(els.SEOJ) );

							//log('Predefined device '+mm.eoj_id_map[els.SEOJ]+' replied') ;
						}
					} else {
						var devid = ELDB[seoj].objectType ;
						if( devid == undefined ) return ;
						var c = localStorage.getItem(devid+'_Count',0) + 1 ;
						localStorage.setItem(devid+'_Count',c) ;

						devid = devid+'_'+c ;
						mm.eoj_id_map[els.SEOJ] = devid ;
						mm.devices[devid] = { eoj : els.SEOJ } ;

						registerExistingDevice(devid) ;
						// Request for property map
						EL.getPropertyMaps( ip, EL.toHexArray(els.SEOJ) );

						log('New device '+devid+' found') ;
					}
				}


				for( var epc in epcList ) {
					var tgt = (seoj=='0ef0' ? mm.nodeprofile : mm.devices[ mm.eoj_id_map[els.SEOJ] ]) ;

					var epco = undefined , epcType = undefined , edtConvFunc = undefined ;
					if( seoj != '0ef0'){
						epco = ELDB['0000'].epcs[epc] ;
						if( epco != undefined ){
							epcType = epco.epcType ;
							if( epco.edtConvFuncs != undefined )	edtConvFunc = epco.edtConvFuncs[0] ;
						}
					}
					if( ELDB[seoj] != undefined ){
						epco = ELDB[seoj].epcs[epc] ;
						if( epco != undefined ){
							if( epco.epcType != undefined )			epcType = epco.epcType ;
							if( epco.edtConvFuncs != undefined )	edtConvFunc = epco.edtConvFuncs[0] ;
						}
					}

					if(epcType == undefined)	epcType = epc ;
					var edt = (edtConvFunc==undefined	? epcList[epc] : edtConvFunc(epcList[epc]) ) ;
					tgt[epcType] = edt ;

					// reply of get request? (works only for first OPC)
					// Ideally, this process should be outside of epc loop, but
					// just to easily get epc & edt, ESV=72 is exceptionally
					// placed here.
					if( procCallWaitList[els.TID] != undefined ){
						if( els.ESV == '72' /* && els.OPC == '01'*/ ){
							procCallWaitList[els.TID]({epc:epc,value:edt}) ;
							delete procCallWaitList[els.TID] ;
						}	// ESV == '52' is processed outside of epc loop.
					}

					if( els.TID == '0000' && seoj!='0ef0' /*nodeprofile does not publish*/)
						pluginInterface.publish(mm.eoj_id_map[els.SEOJ] , epcType , {epc:epc,value:edt} ) ;
				}


				// Reply of SetC request
				if( procCallWaitList[els.TID] != undefined ){
					if( els.ESV == '71' ){	// accepted
						procCallWaitList[els.TID]({epc:els.DETAIL.slice(0,2),success:'SetC request accepted.'}) ;
						delete procCallWaitList[els.TID] ;
					} else if( els.ESV == '51' || els.ESV == '52' ){	// cannot reply
						procCallWaitList[els.TID]({error:'Cannot complete the request.',els:els}) ;
						delete procCallWaitList[els.TID] ;
					}
				}

				savemac() ;

			}catch(e) {
				console.error("EL.renewFacilities error.");
				console.dir(e);
			}
		}).catch( ()=>{
			// Do nothing
			log('No id is found for ip '+ip);
		}) ;
	};

	var elsocket = EL.initialize(
		[MY_EOJ.map(e=>('0'+e.toString(16)).slice(-2)).join('')] , ( rinfo, els ) => {}) ;

	EL.search();
	setInterval(()=>{EL.search();},DEVICE_MULTICAST_INTERVAL) ;

	// Plugin must return (possibly in promise) procedure call callback function.
	// The signature is ( method , devid , propertyname , argument )
	return onProcCall ;
} ;

var procCallWaitList = {} ;

function getPropVal(devid,epc_hex){
	//log('GetPropVal:'+JSON.stringify(arguments)) ;
	return new Promise( (ac,rj)=>{
		var tid = localStorage.getItem('TransactionID',1)+1 ;
		if( tid > 0xFFFF ) tid = 1 ;
		localStorage.setItem('TransactionID',tid) ;

		var mac = getMacFromDeviceId(devid) ;
		var ip = macs[mac].ip ;
		var deoj = macs[mac].devices[devid].eoj ;
		deoj = [deoj.slice(0,2),deoj.slice(2,4),deoj.slice(-2)].map(e=>parseInt('0x'+e)) ;

		buffer = new Buffer([
			0x10, 0x81,
			(tid>>8)&0xff, tid&0xff,
			MY_EOJ[0], MY_EOJ[1], MY_EOJ[2],
			deoj[0], deoj[1], deoj[2],
			0x62,
			0x01,
			parseInt('0x'+epc_hex),
			0x00]);

		var tid_key = ('000'+tid.toString(16)).slice(-4) ;
		procCallWaitList[tid_key] = ac ;
		EL.sendBase( ip, buffer );	// Send main

		setTimeout(()=>{
			if( procCallWaitList[tid_key] == ac){
				delete procCallWaitList[tid_key] ;
				rj( {error:`GET request timeout:${devid}/${epc_hex}`} ) ;
			}
		},GET_TIMEOUT) ;
	}) ;
}

function setPropVal(devid,epc_hex,edt_array){
	//log('SetPropVal:'+JSON.stringify(arguments)) ;
	return new Promise( (ac,rj)=>{
		var tid = localStorage.getItem('TransactionID',1)+1 ;
		if( tid > 0xFFFF ) tid = 1 ;
		localStorage.setItem('TransactionID',tid) ;

		var mac = getMacFromDeviceId(devid) ;
		var ip = macs[mac].ip ;
		var deoj = macs[mac].devices[devid].eoj ;
		deoj = [deoj.slice(0,2),deoj.slice(2,4),deoj.slice(-2)].map(e=>parseInt('0x'+e)) ;

		buffer = new Buffer([
			0x10, 0x81,
			(tid>>8)&0xff, tid&0xff,
			MY_EOJ[0], MY_EOJ[1], MY_EOJ[2],
			deoj[0], deoj[1], deoj[2],
			0x61,	// SetC, instead of SetI
			0x01,
			parseInt('0x'+epc_hex),
			edt_array.length
			].concat(edt_array));

		var tid_key = ('000'+tid.toString(16)).slice(-4) ;
		procCallWaitList[tid_key] = ac ;
		EL.sendBase( ip, buffer );	// Send main

		setTimeout(()=>{
			if( procCallWaitList[tid_key] == ac){
				delete procCallWaitList[tid_key] ;
				rj( {error:`GET request timeout:${devid}/${epc_hex}`} ) ;
			}
		},GET_TIMEOUT) ;
	}) ;
}

function registerExistingDevice( devid ){
	var mac = getMacFromDeviceId(devid) ;
	var ip = macs[mac].ip ;
	var dev = macs[mac].devices[devid] ;

	if( dev.active === true ){
		log('Cannot register '+devid+' twice.') ;
		return ;
	}
	dev.active = true ;
	savemac() ;

	log(`Device ${devid}:${ip} registered.`) ;
}


///////////////////////////////////////////////////////
///////////////////////////////////////////////////////
///
///           Procedure call request
///


function onProcCall( method , _devid , propname , argument ){
	if( _devid == undefined || propname == undefined ){
		switch(method){
		case 'GET' :
			return onProcCall_Get( method , _devid , propname , argument ) ;
		case 'PUT' :
		case 'SET' :
			return onProcCall_Put( method , _devid , propname , argument ) ;
		}
		return {error:`The specified method ${method} is not implemented in echonet lite plugin.`} ;
	}
	var devids = expandDeviceIdFromPossiblyRegExpDeviceId(
		decodeURIComponent(_devid)) ;
	switch(method){
	case 'GET' :
		return new Promise( (acpt,rjct)=>{
			Promise.all( devids.map(devid=>new Promise( (ac,rj)=>{
					onProcCall_Get( method , devid , propname , argument )
						.then( re=>{ ac([devid,re]) ; }).catch(err=>{ac([devid,err]);}) ;
			})) ).then(re=>{
				var res = {} ;
				re.forEach(_re=>{res[_re[0]]=_re[1];}) ;
				acpt(res) ;
			})
		}) ;
	case 'PUT' :
	case 'SET' :
		return new Promise( (acpt,rjct)=>{
			Promise.all( devids.map(devid=>new Promise( (ac,rj)=>{
					onProcCall_Put( method , devid , propname , argument )
						.then( re=>{ ac([devid,re]) ; }).catch(err=>{ac([devid,err]);}) ;
			})) ).then(re=>{
				var res = {} ;
				re.forEach(_re=>{res[_re[0]]=_re[1];}) ;
				acpt(res) ;
			})
		}) ;
		//return onProcCall_Put( method , devid , propname , argument ) ;
	}
	return {error:`The specified method ${method} is not implemented in echonet lite plugin.`} ;
}

function onProcCall_Get( method , devid , propname , argument ){
	var _args = argument.split('&') , args = {} ;
	_args.forEach(eq=>{
		var terms = eq.split('=');
		if( terms[0].trim().length==0) return ;
		args[terms[0]]=(terms.length==1?null:terms[1]);
	}) ;
	if( devid == undefined ){	// access 'echonet/' => device list
		var devices = {} ;
		for( var mac in macs ){
			for( var devid in macs[mac].devices ){
				var dev = macs[mac].devices[devid] ;
				devices[devid]={
					mac:mac
					,ip:macs[mac].ip
				} ;

				if( args.option === 'true'){
					devices[devid].option = {
						doc : {
							short : `EOJ:${dev.eoj} IP:${macs[mac].ip}`
							,long : (dev.active?'Active':'Inactive')+".\nMac address: "+mac
						}
						, leaf : false
					} ;
				}
			}
		}
		return devices ;
	}

	if( propname == undefined ){	// access 'echonet/devid/' => property list
		// Ideally, property map should be checked.
		var mac = getMacFromDeviceId(devid) ;
		if( mac == undefined )	return {error:'No such device:'+devid} ;
		var dev = macs[mac].devices[devid] ;
		var eoj = dev.eoj.substring(0,4) ;
		var names ;
		if( args.option === 'true'){
			names = JSON.parse( fs.readFileSync(
				pluginInterface.getpath()+'all_'+LOCALE+'.json','utf-8')).names ;
		}

		var re = {} ;
		if( eoj != '0ef0'){
			for( var epc in ELDB['0000'].epcs ){
				var epco = ELDB['0000'].epcs[epc] ;
				var epcType = epco.epcType ;
				var cache_value = dev[epcType] ;
				re[epcType] = {
					super : true
					, cache : (cache_value==undefined?null:cache_value)
					, epcName : epco.epcName
				} ;

				if( names != undefined ){
					re[epcType].option = {
						leaf : true
						,doc : {
							short : `${epco.epcName} EPC:${epc}`+(cache_value==undefined?'':' Cache:'+cache_value)
							,long : (epco.epcDoc==undefined?undefined:names[epco.epcDoc])
						}
					}
				}
			}
		}

		for( var epc in ELDB[eoj].epcs ){
			var epco = ELDB[eoj].epcs[epc] ;
			var epcType = epco.epcType ;
			var cache_value = dev[epcType] ;
			re[epcType] = {
				super : false
				, cache : (cache_value==undefined?null:cache_value)
				, epcName : epco.epcName
				//, epcDoc : (names==undefined||epco.epcDoc==undefined?undefined:names[epco.epcDoc])
			} ;

			if( names != undefined ){
				re[epcType].option = {
					leaf : true
					,doc : {
						short : `${epco.epcName} EPC:${epc}`+(cache_value==undefined?'':' Cache:'+cache_value)
						,long : (epco.epcDoc==undefined?undefined:names[epco.epcDoc])
					}
				}
			}
		}
		delete names ;

		return re ;
	}

	var mac = getMacFromDeviceId(devid) ;
	if( mac == undefined )	return {error:'No such device:'+devid} ;

	var epc_hex ;
	var epcs = ELDB[macs[mac].devices[devid].eoj.slice(0,4)].epcs ;
	for( var epc in epcs ){
		if( propname === epcs[epc].epcType ){
			epc_hex = epc ;
			break ;
		}
	}
	if( epc_hex == undefined ){
		if(propname.length == 2 && parseInt('0x'+propname)!=NaN)
			epc_hex = propname.toLowerCase() ;
		else if(parseInt(propname)!=NaN)
			epc_hex = ('0'+(parseInt(propname)&0xff).toString(16)).slice(-2) ;
		else return {error:'Unknown property name:'+propname} ;
	}
	
	return getPropVal(devid,epc_hex) ;
}

function onProcCall_Put( method , devid , propname , argument ){
	if( devid == undefined || propname == undefined || (argument.length==0) )
		return {error:`Device id, property name, and the argument "param" (or "p") must be provided for ${method} method.`} ;

	var mac = getMacFromDeviceId(devid) ;
	if( mac == undefined )	return {error:'No such device:'+devid} ;

	var epc_hex = undefined , edtConvFunc = undefined ;
	var eoj = macs[mac].devices[devid].eoj.slice(0,4) ;
	var epcs = ELDB[eoj].epcs ;
	for( var epc in epcs ){
		if( propname === epcs[epc].epcType ){
			epc_hex = epc ;
			break ;
		}
	}
	if( epc_hex == undefined ){
		if(propname.length == 2 && parseInt('0x'+propname)!=NaN)
			epc_hex = propname.toLowerCase() ;
		else if(parseInt(propname)!=NaN)
			epc_hex = ('0'+(parseInt(propname)&0xff).toString(16)).slice(-2) ;
		else return {error:'Unknown property name:'+propname} ;
	}

	if( epcs[epc_hex].edtConvFuncs != undefined )
		edtConvFunc = epcs[epc_hex].edtConvFuncs[1] ;
	else if( eoj != '0ef0' ){
		var epco = ELDB['0000'].epcs[epc_hex] ;
		if( epco != undefined && epco.edtConvFuncs != undefined )
			edtConvFunc = epco.edtConvFuncs[1] ;
	}

/*
	if( argument.param !== undefined)
		argument.p = argument.param ;
	if( argument.p==undefined && argument.param == undefined ){
		for( var param in argument){
			if( argument[param] === '')	// ?..   (.. = directly epc hex)
				argument.p = param ;
		}
	}*/
	var edthexstr =
		(edtConvFunc==undefined	? argument : edtConvFunc(argument)) ;

	var edt = [] ;
	while( edthexstr.length>0 ){
		var e = edthexstr.slice(0,2) ;
		edthexstr = edthexstr.slice(2) ;

		e = parseInt('0x'+e) ;
		if( e != NaN ){		edt.push(e) ; continue ; }
		// Error. edt remain fixed.
	}

	return setPropVal(devid,epc_hex,edt) ;
}