let pluginInterface ;
let log = console.log ;
let localStorage ;
let ipv4 = require('./ipv4.js');
let cryptico = require('cryptico');
let sudo = require('./sudo.js');
const pathm = require('path');
var fs = require('fs');
const exec = require('child_process').exec;

const MyLocalStorage = require('../../../MyLocalStorage.js') ;
const SingleFileLocalStorage = MyLocalStorage.SingleFileLocalStorage ;
const MYPATH  = __filename.split(pathm.sep).slice(0,-1).join('/') ;
const clLocalStorage = new SingleFileLocalStorage(MYPATH+'/../../../clients/localstorage.json') ;

const NMCLI_CONNECTION_NAME_PREFIX = 'picogw_conn' ;

const RSA_BITS = 1024 ;
let rsaKey , pubKey ;

exports.init = function(pi){
	pluginInterface = pi ;
	log = pluginInterface.log ;
	localStorage = pluginInterface.localStorage ;

	ipv4.setNetCallbackFunctions(
		function(newid,newip){
			for( let plugin_name in netIDCallbacks )
				if( netIDCallbacks[plugin_name].onNewIDFoundCallback != undefined )
					netIDCallbacks[plugin_name].onNewIDFoundCallback(newid,newip) ;
		}
		,function(id,lostip){
			for( let plugin_name in netIDCallbacks )
				if( netIDCallbacks[plugin_name].onIPAddressLostCallback != undefined )
					netIDCallbacks[plugin_name].onIPAddressLostCallback(id,lostip) ;
		}
		,function(id,recoveredip){
			for( let plugin_name in netIDCallbacks )
				if( netIDCallbacks[plugin_name].onIPAddressRecoveredCallback != undefined )
					netIDCallbacks[plugin_name].onIPAddressRecoveredCallback(id,recoveredip) ;
		}
		,function(id,oldip,newip){
			for( let plugin_name in netIDCallbacks )
				if( netIDCallbacks[plugin_name].onIPAddressChangedCallback != undefined )
					netIDCallbacks[plugin_name].onIPAddressChangedCallback(id,oldip,newip) ;
		}
	) ;

	pluginInterface.setOnGetSettingsSchemaCallback( function(){
   		return new Promise((ac,rj)=>{
		  try {
			let schema_json = JSON.parse(fs.readFileSync(pluginInterface.getpath()+'settings_schema.json').toString()) ;
			let schema_default_json = JSON.parse(fs.readFileSync(pluginInterface.getpath()+'settings_schema_default.json').toString()) ;
			let schema_wlan_json = JSON.parse(fs.readFileSync(pluginInterface.getpath()+'settings_schema_wlan.json').toString()) ;

			let cl_settings = clLocalStorage.content() ;
			let cur_settings ;
			try {
				cur_settings = JSON.parse(fs.readFileSync(pluginInterface.getpath()+'settings.json').toString()) ;
			} catch(e){
				cur_settings = {} ;
			} ;

			if( typeof cl_settings == 'object' ){
				cur_settings.api_filter = {} ;
				let set_prop = {};//schema_json.properties ;
				for( let clname in cl_settings ){
					set_prop[clname] = {
						title: clname+' client allowed path in regexp'
						,type:'string'
					} ;
					if(cl_settings[clname].filter != null )
						set_prop[clname].default = cl_settings[clname].filter ;

					cur_settings.api_filter[clname] = cl_settings[clname].filter ;
				}
				schema_json.properties.api_filter.properties = set_prop ;
				//fs.writeFileSync(pluginInterface.getpath()+'settings.json',JSON.stringify(cur_settings,null,'\t')) ;
			}

			exec('nmcli d', (err, stdout, stderr) => {
				let lines = stdout.split("\n") ;
				if( err || lines.length<2 ){
				  	delete schema_json.properties.interfaces ;
				  	delete schema_json.properties.detail ;
				  	delete schema_json.properties.root_passwd ;
				  	schema_json.properties.network_settings = {
				  		type:'object'
				  		,description: 'nmcli should be installed to setup network configuration. Execute\n\n'
				  		+'"$ sudo apt-get install network-manager"\n\nor\n\n"$ sudo yum install NetworkManager"\n\n'
				  		+'Also, you need to free your network devices from existing framework by, for example, edit /etc/network/interfaces to contain only two lines:\n\n'
				  		+'"auto lo",\n'
				  		+'"iface lo inet loopback"\n\n'
				  		+'and reboot. In addition, you may want to uninstall dhcpcd5 (if exist) by\n\n'
				  		+'"$ sudo apt-get purge dhcpcd5"'
				  	} ;
				  	ac( schema_json ) ;
				} else {
					lines.shift() ;
					if( lines.length==0 ){ ac({error:'No network available.'}) ; return ; }

					let cur_settings_interf , cur_settings_ap ;

					if( typeof cur_settings.interfaces == 'object' ){
						for( let k in cur_settings.interfaces ){
							cur_settings_interf = k ;
							if( k.indexOf('wlan')==0 )
								cur_settings_ap = cur_settings.interfaces[k].apname ;
						}
					}

					// Correct visible APs should be listed
					let bWlanExist = false ;
					let interfaces = [] ;
					lines.forEach( line=>{
					  	let sp = line.trim().split(/\s+/) ;
					  	if( sp.length < 4 || sp[0]=='lo') return ;	// Illegally formatted line
						if( sp[0].indexOf('wlan')==0 ) bWlanExist = true ;
					  	interfaces.push(sp[0]) ;
					}) ;

					// Previously set interface does not exist any more..
					if( cur_settings_interf !=undefined && interfaces.indexOf[cur_settings_interf]<0){
						log(`Previously set interface ${cur_settings_interf} does not exist now`) ;
						interfaces.unshift(cur_settings_interf) ;
					}

					interfaces.forEach( interf=>{
				  		let prop = {} ;

						prop[interf] = ( interf.indexOf('wlan')==0 ? schema_wlan_json : schema_default_json ) ;

					  	schema_json.properties.interfaces.oneOf.push({
					  		title:interf
					  		,type:'object'
					  		,additionalProperties: false
					  		,properties:prop
					  	}) ;
					}) ;

					if( schema_json.properties.interfaces.oneOf.length==0){ ac({error:'No network available.'}) ; return ; }

					if( !bWlanExist ){
				   		ac( schema_json ) ;
						//log(JSON.stringify(schema_json,null,'\t')) ;
					} else { // WiFi scan
						exec('nmcli dev wifi list', (err, stdout, stderr) => {
							if( err )	log('Cannot scan Wifi APs (possibly because "nmcli dev wifi list" command requires sudo?)') ;
							let lines = stdout.split("\n") ;
							lines.shift() ;
							lines.forEach( line=>{
								let li = line.indexOf('Infra') ;
								if( li==-1 ) li = line.indexOf('インフラ') ;
								if( li==-1 ) return ;
							  	let sp = line.slice(0,li).trim() ;
							  	if( sp[0]=='*') sp = sp.slice(1).trim() ;
							  	if( sp == '--' ) return ;
								schema_wlan_json.properties.apname.enum.push(sp) ;
							} ) ;

							if( schema_wlan_json.properties.apname.enum.length == 0 )
								log('No valid Wifi IP found.') ;

							if( cur_settings_ap !=undefined && schema_wlan_json.properties.apname.enum.indexOf[cur_settings_ap]<0){
								log(`Previously set AP ${cur_settings_ap} is invisible now`) ;
								schema_wlan_json.properties.apname.enum.unshift(cur_settings_ap) ;
							}

							ac( schema_json ) ;
							//log(JSON.stringify(schema_json,null,'\t')) ;
						}) ;
					}
				}
			});
	   	  } catch(e){ac({error:e.toString()});}

		}) ;
	}) ;

	pluginInterface.setOnSettingsUpdatedCallback( function(newSettings){
		return new Promise((ac,rj)=>{
			if( newSettings.server_port != -1 )
				pluginInterface.publish('client_settings',{port:newSettings.server_port}) ;

			for( let cl_name in newSettings.api_filter ){
				let clo = clLocalStorage.getItem(cl_name) ;
				clo.filter = newSettings.api_filter[cl_name] ;
				clLocalStorage.setItem(cl_name,clo) ;
			}

			if( newSettings.interfaces != null ){
				let root_pwd = newSettings.root_passwd ;
				newSettings.root_passwd = '' ;	// Root password is not saved to the file
				//ac();return;
				//log('NewSettings:') ;
				//log(JSON.stringify(newSettings,null,'\t')) ;

				let interf ;
				for( let k in newSettings.interfaces )
					interf = k ;
				let ss = newSettings.interfaces[interf] ;

				const NMCLI_CONNECTION_NAME = NMCLI_CONNECTION_NAME_PREFIX + '_' + interf ;
				let commands = [] ;
				// Delete connection (may fail for first time)
				commands.push(['nmcli','connection','down',NMCLI_CONNECTION_NAME]) ;
				commands.push(['nmcli','connection','delete',NMCLI_CONNECTION_NAME]) ;

				if( interf.indexOf('wlan')==0 ){
					commands.push(['nmcli','connection','add','con-name',NMCLI_CONNECTION_NAME
						,'type','wifi','ifname', interf, 'ssid'
						,(ss.apname_manual.trim().length==0 ? ss.apname : ss.apname_manual.trim())]) ;
				} else if( interf.indexOf('eth')==0 )
					commands.push(['nmcli','connection','add','con-name',NMCLI_CONNECTION_NAME
					 ,'type','ethernet','ifname', interf]) ;


				if( newSettings.detail.ip == undefined ){	// DHCP
					commands.push(['nmcli','connection','modify',NMCLI_CONNECTION_NAME
					 ,'ipv4.method','auto']) ;
				} else {	// static ip
					if( newSettings.detail.default_gateway == undefined )	newSettings.detail.default_gateway = '' ;
					let ipSetting = (newSettings.detail.ip+' '+newSettings.detail.default_gateway).trim() ;
					commands.push(['nmcli','connection','modify',NMCLI_CONNECTION_NAME
						,'ipv4.method','manual','ipv4.addresses',ipSetting]) ;
				}

				if( interf.indexOf('wlan')==0 ){
					if( ss.password != ss.password2 ){
						rj('Password mismatch.') ;
						return ;
					}
					const ap_pwd = ss.password ; ss.password = ss.password2 = '' ;
					commands.push(['nmcli','connection','modify',NMCLI_CONNECTION_NAME
						,'wifi-sec.key-mgmt','wpa-psk','wifi-sec.psk',ap_pwd]) ;
				}
				//commands.push(['nmcli','connection','down', NMCLI_CONNECTION_NAME]) ;
				commands.push(['nmcli','connection','up'  , NMCLI_CONNECTION_NAME]) ;

				//log('Commands:') ;
				//log(JSON.stringify(commands,null,'\t')) ;

				const ignore_error_cmds = ['delete','down' /*,'up'*/] ;
				function ex(){
					if( commands.length==0 ){
						ipv4.refreshMyAddress() ;
						ac() ;
						return ;
					}
					let cmd = commands.shift() ;
					//log('Exec:'+cmd.join(" ")) ;
					let child = sudo(cmd,{password:root_pwd}) ;
					child.stderr.on('data',dat=>{
						console.error('Error in executing\n$ '+cmd.join(' ')+'\n'+dat.toString()) ;
						if( ignore_error_cmds.indexOf(cmd[2]) >= 0 ) return ;
						rj('Error in executing\n\n$ '+cmd.join(' ')+'\n\n'+dat.toString()) ;	// Interrupt execution
						commands = [] ;
					}) ;
					child.stdout.on('close',()=>{
						if( commands.length == 0 ){
							ipv4.refreshMyAddress() ;
							ac() ;
							return ;
						} else ex() ;
					}) ;
				}
				ex() ;
			}
		}) ;
	}) ;

	// Plugin must return (possibly in promise) procedure call callback function.
	// The signature is ( method , devid , propertyname , argument )
	return onProcCall;
	//	return ( method , devid , propertyname , argument) => 'Admin proc call: '+procname+'('+JSON.stringify(argument)+')' ;
} ;

// Returns promise
exports.getNetIDFromIPv4Address_Forward = function(ipv4addr) {
	return ipv4.getNetIDFromIPv4Address(ipv4addr) ;
}

// callbacks_obj can contain the following four members
// onNewIDFoundCallback			: function(newid,newip) ;
// onIPAddressLostCallback		: function(id,lostip) ;
// onIPAddressRecoveredCallback	: function(id,recoveredip) ;
// onIPAddressChangedCallback	: function(id,oldip,newip) ;
var netIDCallbacks = {} ;
exports.setNetIDCallbacks_Forward = function(plugin_name , callbacks_obj) {
	netIDCallbacks[plugin_name] = callbacks_obj ;
} ;

function onProcCall( method , path /*devid , propname*/ , args ){
	switch(method){
	case 'GET' :
		return onProcCall_Get( method , path /*devid , propname*/ , args ) ;
	/*case 'POST' :
		if(devid!='settings' || args == undefined)
			return {error:'The format is wrong for settings.'} ;
		if( args.schedule instanceof Array && logger.updateschedule(args.schedule) )
			return {success:true,message:'New schedule settings are successfully saved'} ;
		else
			return {error:'Error in saving scheduled logging'} ;*/
	}
	return {error:`The specified method ${method} is not implemented in admin plugin.`} ;
}

function onProcCall_Get( method , path /*serviceid , propname*/ , args ){
	let path_split = path.split('/') ;
	const serviceid = path_split.shift() ;
	const propname = path_split.join('/') ;

	if( serviceid == '' ){	// access 'admin/' => service list
		var re = { net:{} , server_status:{}} ;
		var macs = ipv4.getmacs() ;
		for( var mac in macs )
			re.net[mac] = macs[mac].active ;

		if( args.option === 'true' ){
			re.net.option={leaf:false,doc:{short:'Mac address of recognized network peers'}} ;
			re.server_status.option={leaf:true,doc:{short:'Check server memory/swap status'}} ;
		}

		return re ;
	}

	if( propname == '' ){	// access 'admin/serviceid/' => property list
		var ret ;
		switch(serviceid){
			case 'net' :
				var macs = ipv4.getmacs() ;
				//log(JSON.stringify(macs)) ;
				ret = {} ;
				for( var mac in macs ){
					var ipaddr = (macs[mac].log.length==0?null:macs[mac].log[0].ip) ;
					ret[mac] = {
						active:macs[mac].active
						,ip:ipaddr
						,localhost:(macs[mac].localhost==true)
					} ;
					if( args.option === 'true' ){
						ret[mac].option = {
							leaf:true
							,doc:{short:(ipaddr==null?'IP:null':ipaddr)}
						}
					}
				}
				return ret ;
			case 'server_status' :
				return new Promise((ac,rj)=>{
					exec('vmstat', (err, stdout, stderr) => {

						if( err )
							ac({error:'Command execution failed.',result:err}) ;
						else if( stdout !== null )
							ac({success:true,result:stdout.split('\n')}) ;
						else 
							ac({error:'Command execution failed.',result:stderr}) ;
					}) ;

				}) ;
		}
		return {error:'No such service:'+serviceid} ;
	}

	switch(serviceid){
		case 'net' :
			var m = ipv4.getmacs()[propname] ;
			if( m == undefined )
				return {error:'No such mac address:'+propname} ;
			return m ;
	}
	return {error:'No such service:'+serviceid} ;
}
