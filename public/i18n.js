/* ============ RIGRX languages ============
   The English text in the code IS the lookup key. T('Choose this company')
   returns the Spanish line when the viewer's language is Spanish, and falls back
   to the English it was given for anything not in the dictionary — so a missing
   translation shows English, never a blank or an error.

   Adding a language later = adding one more dictionary object here. Nothing else.
*/
(function () {

  let LANG = 'en';

  function detectLang() {
    try {
      const saved = localStorage.getItem('rigrx_lang');
      if (saved) return saved;
    } catch (e) {}
    const nav = (typeof navigator !== 'undefined' && navigator.language
      ? navigator.language : '').toLowerCase();
    return nav.startsWith('es') ? 'es' : 'en';
  }

  function setLang(code) {
    LANG = code === 'es' ? 'es' : 'en';
    if (typeof document !== 'undefined') document.documentElement.lang = LANG;
    try { localStorage.setItem('rigrx_lang', LANG); } catch (e) {}
  }

  function getLang() { return LANG; }

  /* Translate. vars fills {placeholders}: T('{n} of 4 responded', {n: 2}) */
  function T(key, vars) {
    const dict = DICTS[LANG];
    let out = (dict && dict[key] != null) ? dict[key] : key;
    if (dict && out === key) {
      for (const pattern of Object.keys(dict).filter(k => /\{[^}]+\}/.test(k))
        .sort((a, b) => b.length - a.length)) {
        const names = [...pattern.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
        const parts = pattern.split(/\{[^}]+\}/g)
          .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const match = String(key).match(new RegExp('^' + parts.map((p, n) =>
          p + (n < names.length ? '(.+?)' : '')).join('') + '$'));
        if (!match) continue;
        out = dict[pattern];
        names.forEach((name, n) => {
          const value = dict[match[n + 1]] != null ? dict[match[n + 1]] : match[n + 1];
          out = out.split('{' + name + '}').join(value);
        });
        break;
      }
    }
    if (vars) for (const k of Object.keys(vars))
      out = out.split('{' + k + '}').join(vars[k]);
    return out;
  }

  /* Count + word, translated: TN(3, '{n} responder', '{n} responders') */
  function TN(n, singular, plural) {
    return T(n === 1 ? singular : plural, { n });
  }

  const es = {
    // ---- shell & auth ----
    'Emergency roadside help for trucks — fast.': 'Auxilio vial de emergencia para camiones — rápido.',
    'Sign in or create an account': 'Inicie sesión o cree una cuenta',
    'Mobile number': 'Número de celular',
    'I am a…': 'Soy…',
    'Truck driver': 'Camionero',
    'Service company': 'Compañía de servicio',
    'Text me a code': 'Envíenme un código por texto',
    'Your number is your account — no passwords.': 'Su número es su cuenta — sin contraseñas.',
    'New numbers create an account; existing ones sign in.': 'Un número nuevo crea una cuenta; uno existente inicia sesión.',
    'Back': 'Atrás',
    'Enter the code we texted you': 'Ingrese el código que le enviamos por texto',
    'Sent to': 'Enviado a',
    'Resend': 'Reenviar',
    'Verify & continue': 'Verificar y continuar',
    'Enter your mobile number': 'Ingrese su número de celular',
    'Enter the 6-digit code': 'Ingrese el código de 6 dígitos',
    'Code re-sent': 'Código reenviado',
    'Sign out': 'Cerrar sesión',
    'Driver': 'Chofer',
    'Request failed': 'La solicitud falló',
    'Home': 'Inicio',
    'Messages': 'Mensajes',
    'Garage': 'Garaje',
    'Page not found.': 'Página no encontrada.',
    'Go home': 'Ir al inicio',

    // ---- dropdowns ----
    'Select…': 'Seleccione…',
    'Other…': 'Otro…',
    'Type it in': 'Escríbalo',
    'Select year…': 'Seleccione año…',
    'Select make…': 'Seleccione marca…',
    'Select model…': 'Seleccione modelo…',
    'Select engine…': 'Seleccione motor…',
    'Select transmission…': 'Seleccione transmisión…',
    'Select axles…': 'Seleccione ejes…',
    'Select size…': 'Seleccione medida…',
    'Select color…': 'Seleccione color…',
    'Select trailer type…': 'Seleccione tipo de remolque…',
    'Select length…': 'Seleccione largo…',
    'Select class…': 'Seleccione clase…',
    'Type the make': 'Escriba la marca',
    'Not a reefer': 'No es reefer',

    // ---- driver setup ----
    'Done — go home': 'Listo — ir al inicio',
    'My Garage': 'Mi Garaje',
    "Welcome — let's set you up": 'Bienvenido — configuremos su cuenta',
    'Step 1 of 3 · about 2 minutes. Broke down right now?': 'Paso 1 de 3 · unos 2 minutos. ¿Averiado en este momento?',
    'Skip, request help first': 'Omitir, pedir ayuda primero',
    'Full name': 'Nombre completo',
    'Email (receipts & updates)': 'Correo (recibos y avisos)',
    'Owner-operator': 'Dueño-operador',
    'Company driver': 'Chofer de compañía',
    'Fleet dispatcher': 'Despachador de flota',
    'Company & MC/DOT # (optional)': 'Compañía y # MC/DOT (opcional)',
    'Continue': 'Continuar',
    'Enter your name': 'Ingrese su nombre',
    'What size truck is this?': '¿De qué tamaño es este camión?',
    'Heavy duty': 'Servicio pesado',
    'Class 7–8 · semi tractors, big rigs': 'Clase 7–8 · tractocamiones, tráilers',
    'Medium duty': 'Servicio mediano',
    'Class 4–6 · box trucks, dumps, service trucks': 'Clase 4–6 · camiones de caja, volteos, de servicio',
    'Light duty': 'Servicio ligero',
    'Class 1–3 · pickups, cargo vans': 'Clase 1–3 · pickups, vans de carga',
    'Unit #': 'Unidad #',
    'Year': 'Año', 'Make': 'Marca', 'Model': 'Modelo', 'Engine': 'Motor',
    'Transmission': 'Transmisión',
    'Axle configuration': 'Configuración de ejes',
    'Steer tire size': 'Medida de llanta de dirección',
    'Drive tire size': 'Medida de llanta de tracción',
    'Wheels': 'Rines', 'Color': 'Color',
    'VIN (optional — speeds up parts)': 'VIN (opcional — agiliza las refacciones)',
    'Extras (optional)': 'Extras (opcional)',
    'Optional': 'Opcional',
    'Add your truck': 'Agregue su camión',
    'Step 2 of 3 — every detail here saves a question at 2 AM': 'Paso 2 de 3 — cada detalle aquí ahorra una pregunta a las 2 AM',
    'Save truck': 'Guardar camión',
    'At least enter the make': 'Al menos indique la marca',
    'Truck saved': 'Camión guardado',
    'Trailer type': 'Tipo de remolque',
    'Trailer #': 'Remolque #',
    'Length': 'Largo', 'Axles': 'Ejes', 'Suspension': 'Suspensión',
    'Tire size': 'Medida de llanta',
    'Reefer unit (if reefer)': 'Unidad de refrigeración (si es reefer)',
    'Doors': 'Puertas', 'Liftgate': 'Rampa elevadora',
    'Yes': 'Sí', 'No': 'No',
    'Hazmat placarded': 'Placas de material peligroso (hazmat)',
    'Class': 'Clase', 'UN #': '# UN',
    'Providers see this before they buy — tow operators must know': 'Los proveedores ven esto antes de comprar — los operadores de grúa deben saberlo',
    'Add your trailer': 'Agregue su remolque',
    'Step 3 of 3 — you can add more rigs anytime in My Garage': 'Paso 3 de 3 — puede agregar más equipos cuando quiera en Mi Garaje',
    'Save trailer': 'Guardar remolque',
    'Finish — go to my dashboard': 'Terminar — ir a mi panel',
    'Cancel': 'Cancelar',
    'Skip — no trailer / bobtail': 'Omitir — sin remolque / bobtail',
    'Trailer saved': 'Remolque guardado',
    'Profile complete — your garage is ready': 'Perfil completo — su garaje está listo',

    // ---- driver home ----
    'Hey': 'Hola',
    'Broke down? Help is minutes away.': '¿Averiado? La ayuda está a minutos.',
    'REQUEST HELP NOW': 'PEDIR AYUDA AHORA',
    'Request #': 'Solicitud #',
    '{n} responder': '{n} respuesta',
    '{n} responders': '{n} respuestas',
    'OPEN': 'ABIERTA', 'SELECTED': 'ELEGIDA', 'COMPLETED': 'COMPLETADA',
    'CANCELLED': 'CANCELADA', 'EXPIRED': 'VENCIDA',
    'open': 'abierta', 'selected': 'elegida', 'completed': 'completada',
    'cancelled': 'cancelada', 'expired': 'vencida',
    'Manage ›': 'Administrar ›',
    'Unit': 'Unidad',
    'Trailer': 'Remolque',
    'Add your truck ›': 'Agregue su camión ›',
    'Add your trailer ›': 'Agregue su remolque ›',
    'No hazmat': 'Sin hazmat',
    'Hazmat: Class': 'Hazmat: Clase',
    'History': 'Historial',
    'No past requests yet': 'Aún no hay solicitudes anteriores',

    // ---- request flow ----
    'What do you need?': '¿Qué necesita?',
    'Step 1 of 4 — pick a service': 'Paso 1 de 4 — elija un servicio',
    'No services available yet': 'Aún no hay servicios disponibles',
    'That service is unavailable': 'Ese servicio no está disponible',
    'Step 2 of 4 — the details providers need': 'Paso 2 de 4 — los detalles que los proveedores necesitan',
    'Truck': 'Camión',
    'No saved truck': 'Sin camión guardado',
    'Bobtail / none': 'Bobtail / ninguno',
    'Situation': 'Situación',
    'On highway shoulder': 'En el acotamiento',
    'Truck stop / lot': 'Parador / estacionamiento',
    'On ramp': 'En la rampa',
    'Blocking traffic': 'Bloqueando el tráfico',
    'Can the truck move under its own power?': '¿El camión puede moverse por sí solo?',
    "Can't move": 'No se mueve',
    'Short distance': 'Distancia corta',
    'What happened?': '¿Qué pasó?',
    'Describe the problem — dash codes, sounds, what you see…': 'Describa el problema — códigos del tablero, ruidos, lo que ve…',
    'Photos (optional but providers respond faster with them)': 'Fotos (opcional, pero los proveedores responden más rápido con ellas)',
    'added': 'agregada',
    '+ Add photo': '+ Agregar foto',
    'Photo added': 'Foto agregada',
    'What kind?': '¿Qué tipo?',
    '(optional — helps them bring the right parts)': '(opcional — les ayuda a traer las refacciones correctas)',
    'Which tire?': '¿Cuál llanta?',
    'Steer axle': 'Eje de dirección',
    'Drive axle 1': 'Eje de tracción 1', 'Drive axle 2': 'Eje de tracción 2', 'Drive axle 3': 'Eje de tracción 3',
    'Trailer axle 1': 'Eje del remolque 1', 'Trailer axle 2': 'Eje del remolque 2', 'Trailer axle 3': 'Eje del remolque 3',
    'Which side?': '¿De qué lado?',
    'Driver side': 'Lado del conductor',
    'Passenger side': 'Lado del pasajero',
    'Inside or outside?': '¿Interior o exterior?',
    'Outside': 'Exterior', 'Inside': 'Interior',
    'Super single (only one tire)': 'Super single (una sola llanta)',
    'What happened to it?': '¿Qué le pasó?',
    'Flat': 'Ponchada', 'Blowout': 'Reventada', 'Low air': 'Baja de aire',
    'Sidewall damage': 'Daño de costado', 'Tread separation': 'Separación de banda',
    'Wheel damage': 'Daño del rin', 'Not sure': 'No estoy seguro',
    'The tire size comes from your saved rig automatically, so they bring the right one.': 'La medida de la llanta sale de su equipo guardado automáticamente, para que traigan la correcta.',
    'Pick which tire so they bring the right one': 'Indique cuál llanta para que traigan la correcta',

    // ---- location ----
    'Where are you?': '¿Dónde está?',
    'Step 3 of 4 — this is how they find you': 'Paso 3 de 4 — así lo encuentran',
    'Location locked': 'Ubicación fijada',
    're-capture': 'volver a capturar',
    'Companies will see': 'Las compañías verán',
    'locating…': 'ubicando…',
    'Exact GPS': 'GPS exacto',
    '(only shown after they buy)': '(solo se muestra después de que compren)',
    'Tap below to share your location.': 'Toque abajo para compartir su ubicación.',
    'Your exact spot stays hidden until a company pays for the lead — they only see the general area first.': 'Su ubicación exacta permanece oculta hasta que una compañía pague por el aviso — primero solo ven el área general.',
    'Use my GPS location': 'Usar mi ubicación GPS',
    'Which way were you headed?': '¿Hacia dónde iba?',
    'Northbound': 'Hacia el norte', 'Southbound': 'Hacia el sur',
    'Eastbound': 'Hacia el este', 'Westbound': 'Hacia el oeste',
    'Not on a highway': 'No estoy en carretera',
    'On a divided highway this is the difference between a 5-minute and a 30-minute response. Companies see it up front so they never have to ask.': 'En una autopista dividida, esto es la diferencia entre una respuesta de 5 o de 30 minutos. Las compañías lo ven de inmediato y no tienen que preguntar.',
    'Landmark or mile marker (optional, helps a lot)': 'Referencia o marcador de milla (opcional, ayuda mucho)',
    'I-5 NB shoulder, mile marker 253, past the Buttonwillow exit': 'Acotamiento I-5 norte, milla 253, pasando la salida Buttonwillow',
    'Only companies that buy your lead see this.': 'Solo las compañías que compren su aviso ven esto.',
    'Share your location to continue — or': 'Comparta su ubicación para continuar — o',
    'enter it by hand': 'ingrésela a mano',
    'No GPS on this device — enter it by hand': 'Este equipo no tiene GPS — ingrésela a mano',
    'Locating…': 'Ubicando…',
    'GPS unavailable — enter it by hand instead': 'GPS no disponible — ingrésela a mano',
    'Type the nearest town and state (example: Buttonwillow, CA)': 'Escriba el pueblo y estado más cercano (ejemplo: Buttonwillow, CA)',
    'Saved — add a mile marker below so they can find you': 'Guardado — agregue un marcador de milla abajo para que lo encuentren',
    'Share your location first': 'Comparta su ubicación primero',

    // ---- review & send ----
    'Ready to send?': '¿Listo para enviar?',
    'Step 4 of 4 — providers near you get alerted instantly': 'Paso 4 de 4 — los proveedores cercanos son avisados al instante',
    "CAN'T MOVE": 'NO SE MUEVE',
    'CAN MOVE': 'SE MUEVE',
    'Not specified': 'No especificado',
    'Type': 'Tipo', 'Tire': 'Llanta', 'Where': 'Dónde', 'Photos': 'Fotos',
    'none': 'ninguna',
    'Who should get this request?': '¿Quién debe recibir esta solicitud?',
    'All approved companies': 'Todas las compañías aprobadas',
    'Licensed companies only': 'Solo compañías con licencia',
    'Only companies whose main work is…': 'Solo compañías cuyo trabajo principal es…',
    '(optional)': '(opcional)',
    'Checking how many companies match…': 'Verificando cuántas compañías coinciden…',
    'No companies match these filters.': 'Ninguna compañía coincide con estos filtros.',
    '{n} would be alerted without them — loosen the choices above, or send anyway and you can widen it after.': '{n} serían avisadas sin ellos — afloje las opciones de arriba, o envíe de todos modos y amplíe después.',
    '{n} company will be alerted': '{n} compañía será avisada',
    '{n} companies will be alerted': '{n} compañías serán avisadas',
    '({n} without your filters)': '({n} sin sus filtros)',
    'Qualified providers near you will be texted the moment you send. Up to': 'Los proveedores calificados cerca de usted recibirán un texto en cuanto envíe. Hasta',
    'can respond — you pick the winner.': 'pueden responder — usted elige al ganador.',
    'Free for you.': 'Gratis para usted.',
    'SEND REQUEST': 'ENVIAR SOLICITUD',
    'No licensed companies nearby — see options below': 'No hay compañías con licencia cerca — vea opciones abajo',
    'No providers cover this area yet': 'Aún no hay proveedores que cubran esta área',
    '{n} provider notified': '{n} proveedor avisado',
    '{n} providers notified': '{n} proveedores avisados',
    ' (search radius expanded)': ' (radio de búsqueda ampliado)',

    // ---- active request ----
    'Help is on the way': 'La ayuda va en camino',
    '{n} company alerted': '{n} compañía avisada',
    '{n} companies alerted': '{n} compañías avisadas',
    'Response Slots': 'Espacios de respuesta',
    'notifying…': 'avisando…',
    '{n} of 4 responded': '{n} de 4 respondieron',
    '3 standard slots + 1 premium slot · you choose the winner': '3 espacios estándar + 1 premium · usted elige al ganador',
    'Nobody matched your filters.': 'Nadie coincidió con sus filtros.',
    'You narrowed this request, and no company nearby fits — so nobody was alerted.': 'Usted limitó esta solicitud y ninguna compañía cercana cumple — así que nadie fue avisado.',
    'Send to all approved companies instead': 'Enviar a todas las compañías aprobadas',
    'No medium-duty companies cover this area yet.': 'Aún no hay compañías de servicio mediano en esta área.',
    'No light-duty companies cover this area yet.': 'Aún no hay compañías de servicio ligero en esta área.',
    'The shops nearby have told us they only work on heavy trucks. Your request stays open in case one widens their coverage — call around in the meantime.': 'Los talleres cercanos nos dijeron que solo trabajan con camiones pesados. Su solicitud queda abierta por si alguno amplía su cobertura — mientras tanto, llame por teléfono.',
    "Waiting for providers to respond… you'll get a text the second one does.": 'Esperando respuesta de los proveedores… recibirá un texto en cuanto alguien responda.',
    'Message them before you choose.': 'Escríbales antes de elegir.',
    "Ask for an ETA and a price, then compare. Choosing is final — it ends the request and tells the other companies they didn't get it.": 'Pida tiempo de llegada y precio, luego compare. Elegir es definitivo — cierra la solicitud y avisa a las demás compañías que no ganaron.',
    'New': 'Nuevo',
    'jobs': 'trabajos',
    ' · premium responder': ' · respondedor premium',
    'LICENSED': 'CON LICENCIA',
    'CHOSEN': 'ELEGIDA',
    'Quoted:': 'Cotizó:',
    'No quote yet — chat with them': 'Sin cotización aún — chatee con ellos',
    'Chat first': 'Chatear primero',
    'Choose': 'Elegir',
    'Mark job complete': 'Marcar trabajo completado',
    'Rate this provider': 'Califique a este proveedor',
    'Cancel request': 'Cancelar solicitud',
    '{n} more company notified': '{n} compañía más avisada',
    '{n} more companies notified': '{n} compañías más avisadas',
    'Choose this company?': '¿Elegir esta compañía?',
    "They get your exact location and mile marker, and they're on their way.": 'Recibirán su ubicación exacta y marcador de milla, y saldrán en camino.',
    "This can't be undone. The other companies will be told they didn't get the job, and your request closes to new responders.": 'Esto no se puede deshacer. A las demás compañías se les avisará que no ganaron el trabajo y su solicitud se cierra a nuevas respuestas.',
    "If you haven't asked for an ETA and price yet, chat with them first.": 'Si aún no ha pedido tiempo de llegada y precio, chatee con ellos primero.',
    'Not yet': 'Todavía no',
    'Yes, choose them': 'Sí, elegirlos',
    'Chosen — they have your location now, the others were told': 'Elegidos — ya tienen su ubicación, a los demás se les avisó',
    'Job marked complete': 'Trabajo marcado como completado',
    'Request cancelled': 'Solicitud cancelada',
    'is on scene': 'está en el lugar',
    'is on the way': 'va en camino',
    'min away': 'min de distancia',
    'min overdue': 'min de retraso',
    'Hablamos español': 'Hablamos español',

    // ---- public profile & rating ----
    'reviews': 'reseñas',
    'New to RIGRX': 'Nuevo en RIGRX',
    'License verified': 'Licencia verificada',
    'License not verified': 'Licencia no verificada',
    'Rating breakdown': 'Desglose de calificaciones',
    'Coverage': 'Cobertura',
    'Recent reviews': 'Reseñas recientes',
    'No reviews yet — new to RIGRX': 'Aún sin reseñas — nuevo en RIGRX',
    'Hazmat certified': 'Certificado hazmat',
    'Rotator on fleet': 'Grúa rotativa en la flota',
    '24/7': '24/7', '24 / 7': '24 / 7',
    'Works at weigh stations & inspection facilities': 'Trabaja en básculas e instalaciones de inspección',
    'Will service placarded hazmat loads': 'Atiende cargas con placas hazmat',
    'Will service a loaded trailer': 'Atiende remolques cargados',
    'Services cargo tanks / tankers': 'Atiende autotanques / pipas',
    'Has a rotator or heavy wrecker': 'Tiene grúa rotativa o grúa pesada',
    'Aluminum welding capable': 'Puede soldar aluminio',
    'Carries tire inventory on the truck': 'Lleva inventario de llantas en el camión',
    'How was the service?': '¿Cómo estuvo el servicio?',
    'Poor': 'Malo', 'Fair': 'Regular', 'Good': 'Bueno',
    'Very good': 'Muy bueno', 'Excellent': 'Excelente',
    'What stood out?': '¿Qué destacó?',
    'Fast response': 'Respuesta rápida', 'Fair price': 'Precio justo',
    'Professional': 'Profesional', 'Fixed right the first time': 'Reparado bien a la primera',
    'Good communication': 'Buena comunicación',
    'Comment (optional)': 'Comentario (opcional)',
    'How did it go?': '¿Cómo le fue?',
    'Submit review': 'Enviar reseña',
    'Thanks — your review is live on their profile': 'Gracias — su reseña ya está en el perfil de la compañía',

    // ---- garage ----
    'Saved rigs make requests take 30 seconds': 'Con equipos guardados, pedir ayuda toma 30 segundos',
    'Edit': 'Editar', 'Delete': 'Eliminar',
    'Engine:': 'Motor:', 'Tires:': 'Llantas:',
    '+ Add truck': '+ Agregar camión', '+ Add trailer': '+ Agregar remolque',
    '+ Add your truck': '+ Agregue su camión', '+ Add your trailer': '+ Agregue su remolque',
    'this truck': 'este camión', 'this trailer': 'este remolque',
    'Remove {x} from your garage?\n\nRequests you have already sent keep their details — this only stops it appearing when you ask for help.': '¿Quitar {x} de su garaje?\n\nLas solicitudes ya enviadas conservan sus datos — solo dejará de aparecer cuando pida ayuda.',
    'Truck removed': 'Camión eliminado',
    'Trailer removed': 'Remolque eliminado',

    // ---- threads & chat ----
    'One thread per request & company': 'Una conversación por solicitud y compañía',
    'No conversations yet': 'Aún no hay conversaciones',
    'Conversation': 'Conversación',
    'Responders': 'Compañías',
    'Jobs': 'Trabajos',
    'Keep your exact spot to yourself until you pick someone — they already have the distance they need to quote you. Once you choose, they get the pin automatically.': 'Guarde su ubicación exacta hasta que elija a alguien — ya tienen la distancia que necesitan para cotizarle. Cuando elija, reciben el pin automáticamente.',
    'Say hello — the other side is notified instantly': 'Salude — el otro lado recibe aviso al instante',
    'Choose this company': 'Elegir esta compañía',
    'Type a message…': 'Escriba un mensaje…',
    'QUOTE': 'COTIZACIÓN',
    'ETA': 'ETA',
    'just now': 'ahora mismo',
    '{n} min ago': 'hace {n} min',
    '{n} hr ago': 'hace {n} h',
    '{n} d ago': 'hace {n} d',
    'Want them to come to you?': '¿Quiere que vayan a usted?',
    'Choosing': 'Al elegir a',
    "sends them your exact pin and turn-by-turn directions automatically — you don't have to type any of it out.": 'le llegan su pin exacto e indicaciones de manejo automáticamente — no tiene que escribir nada.',
    'Heads up: choosing ends your request.': 'Ojo: elegir cierra su solicitud.',
    '{n} other company is on this job': '{n} otra compañía está en este trabajo',
    '{n} other companies are on this job': '{n} otras compañías están en este trabajo',
    ' and {n} has already quoted': ' y {n} ya cotizó',
    ' and {n} have already quoted': ' y {n} ya cotizaron',
    ' and could still come back with a better price': ' y todavía podrían regresar con un mejor precio',
    " — you won't see what they would have charged.": ' — no verá lo que habrían cobrado.',
    'Send it anyway': 'Enviarlo de todos modos',
    'Choose them': 'Elegirlos',
    "You're never forced to share your spot early.": 'Nunca está obligado a compartir su ubicación antes de tiempo.',

    // ---- directions ----
    'Get directions': 'Cómo llegar',
    'Open in:': 'Abrir en:',
    'Coordinates copied': 'Coordenadas copiadas',
    'Copy the coordinates': 'Copiar las coordenadas',

    // ---- city picker ----
    'Start typing a city — any US city works': 'Empiece a escribir una ciudad — cualquier ciudad de EE. UU.',
    'No matching city — check the spelling': 'No hay ciudad que coincida — revise la ortografía',
    'What town are you closest to?': '¿A qué pueblo está más cerca?',
    'Companies will see this as your general area. Add the exact mile marker on the next screen.': 'Las compañías verán esto como su área general. Agregue el marcador de milla exacto en la siguiente pantalla.',
    'Use this town': 'Usar este pueblo',
    'Start typing and pick a city from the list': 'Empiece a escribir y elija una ciudad de la lista',

    // ---- language ----
    'Language': 'Idioma',

    // ---- service catalog (admin-managed; defaults translated, custom ones pass through) ----
    'Tires': 'Llantas',
    'Towing': 'Grúa',
    'Towing & Recovery': 'Grúa y rescate',
    'Mobile Mechanic': 'Mecánico móvil',
    'Engine / Mechanical': 'Motor / Mecánica',
    'Fuel / DEF': 'Combustible / DEF',
    'Fuel & Fluids': 'Combustible y fluidos',
    'Trailer / Reefer': 'Remolque / Reefer',
    "Won't Start": 'No arranca',
    'Lockout': 'Cerrajería',
    'Other': 'Otro',
    'Heavy & medium duty, winch-out': 'Servicio pesado y mediano, rescate con malacate',
    'Replace or repair on the shoulder': 'Cambio o reparación en el acotamiento',
    'Jump, batteries, starter': 'Paso de corriente, baterías, marcha',
    'Diagnostics, derate, air leaks': 'Diagnóstico, derate, fugas de aire',
    'Reefer down, brakes, lights': 'Reefer descompuesto, frenos, luces',
    'Out of fuel, gelled, DEF': 'Sin combustible, diésel gelificado, DEF',
    'Keys locked in the cab': 'Llaves dentro de la cabina',
    'Welding, glass, hydraulics…': 'Soldadura, cristales, hidráulica…',
    // provider trades (shown as driver filters)
    'Heavy towing & recovery': 'Grúa pesada y rescate',
    'Commercial tire service': 'Servicio de llantas comerciales',
    'Mobile diesel mechanic': 'Mecánico diésel móvil',
    'Trailer & reefer repair': 'Reparación de remolques y reefer',
    'Tanker & pump service': 'Servicio de pipas y bombas',
    'Fuel & fluid delivery': 'Entrega de combustible y fluidos',
    'Mobile welding & hydraulics': 'Soldadura móvil e hidráulica',
    'Lockout & glass': 'Cerrajería y cristales',

    // ---- shared usability states, provider, team and administration ----
    'Loading': 'Cargando',
    'Retry': 'Reintentar',
    "Couldn't load this page — check your connection and try again.": 'No se pudo cargar esta página — revise su conexión e inténtelo de nuevo.',
    'You are offline. Reconnect and try again.': 'No tiene conexión. Reconéctese e inténtelo de nuevo.',
    'Connection lost. Reconnect and try again.': 'Se perdió la conexión. Reconéctese e inténtelo de nuevo.',
    'You are offline. Your entered details stay on this device.': 'No tiene conexión. Los datos ingresados permanecen en este dispositivo.',
    'Reconnect': 'Reconectar',
    'Back online — updates are connected': 'De nuevo en línea — las actualizaciones están conectadas',
    'Optional now — add rig details later to save questions at 2 AM': 'Opcional por ahora — agregue detalles del equipo después para ahorrar preguntas a las 2 AM',
    'Live Leads': 'Avisos en vivo',
    'My Leads': 'Mis avisos',
    'Stats': 'Estadísticas',
    'Your team': 'Su equipo',
    'Settings': 'Configuración',
    'My jobs': 'Mis trabajos',
    'Overview': 'Resumen',
    'Providers': 'Proveedores',
    'Drivers': 'Choferes',
    'Services': 'Servicios',
    'Pricing': 'Precios',
    'Sales': 'Ventas',
    'Requested': 'Solicitados',
    'Dispatch': 'Despacho',
    'Chat flags': 'Alertas de chat',
    'Verified provider': 'Proveedor verificado',
    'Pending approval': 'Aprobación pendiente',
    'New message': 'Nuevo mensaje',
    'A job was assigned': 'Se asignó un trabajo',
    'A job assignment changed': 'Cambió una asignación de trabajo',
    'Job status updated': 'Se actualizó el estado del trabajo',
    'A driver needs dispatch help': 'Un chofer necesita ayuda de despacho',
    'A job returned to dispatch': 'Un trabajo volvió a despacho',
    'A job was cancelled': 'Se canceló un trabajo',
    'A driver reopened a request': 'Un chofer reabrió una solicitud',
    'You got the job!': '¡Obtuvo el trabajo!',
    'Driver went with another provider': 'El chofer eligió otro proveedor',
    'Processing…': 'Procesando…',
    'Saving…': 'Guardando…',
    'Saved': 'Guardado',
    'Added': 'Agregado',
    'Refunded': 'Reembolsado',
    'Approve': 'Aprobar',
    'Reject': 'Rechazar',
    'Acknowledge': 'Confirmar',
    'Resolve': 'Resolver',
    'Retry now': 'Reintentar ahora',
    'Refund': 'Reembolsar',
    'No results yet': 'Aún no hay resultados',
    'No jobs assigned yet': 'Aún no hay trabajos asignados',
    'No leads match this view': 'Ningún aviso coincide con esta vista'
    ,'Profile saved — you can add your rig later': 'Perfil guardado — puede agregar su equipo después'
    ,'Enter a valid mobile number': 'Ingrese un número de celular válido'
    ,'Enter your business name': 'Ingrese el nombre de su compañía'
    ,'Enter a valid dispatch phone': 'Ingrese un teléfono de despacho válido'
    ,'Enter a team member name': 'Ingrese el nombre del miembro del equipo'
    ,'Check the highlighted field': 'Revise el campo señalado'
    ,'Three standard buyers pay the listed price. One final premium buyer may force in at 2×; no more than four companies ever receive this driver’s identity. RIGRX approval is reviewed by our team, while license status comes from the document the company provided. If the driver cannot be reached, the purchase is eligible for refund review.': 'Tres compradores estándar pagan el precio indicado. Un comprador premium final puede entrar por 2×; nunca más de cuatro compañías reciben la identidad del chofer. La aprobación de RIGRX la revisa nuestro equipo; el estado de licencia proviene del documento entregado por la compañía. Si no se puede contactar al chofer, la compra puede revisarse para reembolso.'
    ,'No charge — one lead credit will be used': 'Sin cargo — se usará un crédito de aviso'
    ,'Payment simulation mode — no real charge': 'Modo de simulación de pago — sin cargo real'
    ,'The exact listed amount is charged to your card on file': 'El monto exacto indicado se carga a su tarjeta registrada'
    ,'Unreachable-driver purchases are reviewed under the refund policy': 'Las compras con chofer inubicable se revisan bajo la política de reembolso'
    ,'Dismiss': 'Cerrar'
    ,'Dismiss notice': 'Cerrar aviso'
    ,'Live updates disconnected. Reconnecting…': 'Se desconectaron las actualizaciones en vivo. Reconectando…'
    ,'Live updates reconnected': 'Las actualizaciones en vivo se reconectaron'
    ,'Essential setup · about 30 seconds. Add truck and trailer details later.': 'Configuración esencial · unos 30 segundos. Agregue los datos del camión y remolque después.'
    ,'Save & request-ready': 'Guardar y quedar listo para pedir ayuda'

    // ---- exhaustive provider, technician, administration and accessibility copy ----
    ,'New {service} lead {band} away — open Live Leads': 'Nuevo aviso de {service} a {band} — abra Avisos en vivo'
    ,'{name} unlocked your request': '{name} desbloqueó su solicitud'
    ,'Approximate town — landmark required': 'Pueblo aproximado — se requiere una referencia'
    ,'This GPS point is more than 15 minutes old. Capture it again or enter a town by hand before sending.': 'Este punto GPS tiene más de 15 minutos. Vuelva a capturarlo o ingrese un pueblo manualmente antes de enviar.'
    ,'Share a current location to continue — or': 'Comparta una ubicación actual para continuar — o'
    ,'That GPS point is stale — capture it again or enter a town by hand': 'Ese punto GPS está desactualizado — vuelva a capturarlo o ingrese un pueblo manualmente'
    ,'Capture a fresh GPS point or enter a town by hand': 'Capture un punto GPS nuevo o ingrese un pueblo manualmente'
    ,'Add a landmark or mile marker for a manual location': 'Agregue una referencia o marcador de milla para una ubicación manual'
    ,'Your chosen company': 'La compañía elegida'
    ,'is preparing your dispatch': 'está preparando su despacho'
    ,'A technician accepted, but has not started toward you yet.': 'Un técnico aceptó, pero aún no ha salido hacia usted.'
    ,'A technician was assigned and has not accepted yet.': 'Se asignó un técnico que aún no ha aceptado.'
    ,'The company still needs to assign a technician.': 'La compañía aún debe asignar un técnico.'
    ,'NOT MOVING YET': 'AÚN NO ESTÁ EN CAMINO'
    ,'Call company': 'Llamar a la compañía'
    ,'Get dispatch help': 'Pedir ayuda a despacho'
    ,'Choose a different responder': 'Elegir otra compañía'
    ,'Search a wider area and alert again': 'Buscar en un área más amplia y volver a avisar'
    ,'{n} companies alerted in the wider search': '{n} compañías avisadas en la búsqueda ampliada'
    ,'No companies matched yet — operations can now see this request': 'Aún no coincidió ninguna compañía — operaciones ya puede ver esta solicitud'
    ,'Dispatch and operations were alerted': 'Se avisó a despacho y operaciones'
    ,'Put this request back with your responders so you can choose another company?': '¿Volver a poner esta solicitud con las compañías que respondieron para elegir otra?'
    ,'Request reopened — choose another responder': 'Solicitud reabierta — elija otra compañía'
    ,'Back to home': 'Volver al inicio'
    ,'Technician': 'Técnico', 'technician': 'técnico', 'dispatcher': 'despachador'
    ,'RIGRX admin': 'Administrador de RIGRX'
    ,'Tell us about your company': 'Cuéntenos sobre su compañía'
    ,"Step 1 of 5 · leads start the day you're approved": 'Paso 1 de 5 · los avisos comienzan el día de su aprobación'
    ,'Business name': 'Nombre de la compañía'
    ,'Dispatch phone (text alerts)': 'Teléfono de despacho (alertas por texto)'
    ,'After-hours phone': 'Teléfono fuera de horario'
    ,'Dispatch email': 'Correo de despacho', 'Hours': 'Horario', 'Scheduled': 'Horario programado'
    ,'Locations & coverage': 'Ubicaciones y cobertura'
    ,"Step 2 of 5 — you get every lead inside ANY location's radius": 'Paso 2 de 5 — recibe cada aviso dentro del radio de CUALQUIER ubicación'
    ,'remove': 'quitar', 'Add at least one location — this is how leads find you.': 'Agregue al menos una ubicación — así lo encuentran los avisos.'
    ,'Add a location': 'Agregar una ubicación', 'City / base': 'Ciudad / base', 'Label': 'Nombre'
    ,'Service radius (miles)': 'Radio de servicio (millas)'
    ,'Up to 5,000 — set it wide if you roll long-distance': 'Hasta 5,000 — amplíelo si recorre largas distancias'
    ,'Location phone (optional)': 'Teléfono de la ubicación (opcional)'
    ,'Add at least one location first': 'Agregue al menos una ubicación primero'
    ,'What services do you offer?': '¿Qué servicios ofrece?'
    ,'Step 3 of 5 — start with what kind of shop you are, then adjust. More boxes = more leads; your rating keeps it honest.': 'Paso 3 de 5 — empiece por el tipo de taller y luego ajuste. Más opciones = más avisos; su calificación mantiene la honestidad.'
    ,'What kind of company are you?': '¿Qué tipo de compañía tiene?'
    ,'This becomes your badge on RIGRX, and it checks the services that trade usually performs. Drivers can choose to send a request only to companies whose main work matches.': 'Esto se convierte en su distintivo en RIGRX y marca los servicios habituales de ese oficio. Los choferes pueden enviar una solicitud solo a compañías cuyo trabajo principal coincida.'
    ,'No services listed under this category yet': 'Aún no hay servicios en esta categoría'
    ,"Something we didn't list?": '¿Falta algún servicio?'
    ,'Custom services go to RIGRX for approval, then join the catalog for everyone': 'Los servicios personalizados se envían a RIGRX para aprobación y luego se agregan al catálogo general'
    ,'Equipment & capacity': 'Equipo y capacidad'
    ,'Step 4 of 5 — drivers see this as proof you can handle the job': 'Paso 4 de 5 — los choferes ven esto como prueba de que puede hacer el trabajo'
    ,'Truck sizes you work on': 'Tamaños de camión que atiende'
    ,"Pick every class you'll take. Leads outside your picks never reach you — and medium duty is a busy market most heavy-only shops skip.": 'Elija todas las clases que atiende. No recibirá avisos fuera de su selección — y el servicio mediano es un mercado activo que muchos talleres de servicio pesado omiten.'
    ,'Heavy wreckers': 'Grúas pesadas', 'Rotator': 'Grúa rotativa', 'Service trucks': 'Camiones de servicio'
    ,'Landoll / traveling axle': 'Landoll / eje desplazable', 'Tire trucks': 'Camiones llanteros', 'Fuel trucks': 'Camiones de combustible'
    ,'What can you take on?': '¿Qué trabajos puede atender?'
    ,'Seven quick answers that send you the right leads and keep the wrong ones away.': 'Siete respuestas rápidas para recibir los avisos adecuados y evitar los demás.'
    ,'Verification & billing': 'Verificación y facturación'
    ,'Step 5 of 5 — drivers trust RIGRX because every company is vetted': 'Paso 5 de 5 — los choferes confían en RIGRX porque verificamos cada compañía'
    ,'Business / tow license #': 'Licencia comercial / de grúa #'
    ,'Certificate of insurance (PDF or photo)': 'Certificado de seguro (PDF o foto)'
    ,'W-9 (PDF or photo)': 'W-9 (PDF o foto)'
    ,'Open requests inside your coverage that match your services': 'Solicitudes abiertas dentro de su cobertura que coinciden con sus servicios'
    ,'No open leads in your area right now.': 'No hay avisos abiertos en su zona ahora.'
    ,"You'll get a text the moment one drops. Widen your radius or add services in Settings to see more.": 'Recibirá un texto en cuanto aparezca uno. Amplíe su radio o agregue servicios en Configuración para ver más.'
    ,'HEAVY': 'PESADO', 'MEDIUM DUTY': 'SERVICIO MEDIANO', 'LIGHT DUTY': 'SERVICIO LIGERO'
    ,'YOURS': 'SUYO', 'Open ›': 'Abrir ›', 'SOLD OUT — PREMIUM OPEN': 'AGOTADO — PREMIUM DISPONIBLE'
    ,'UNLOCKED': 'DESBLOQUEADO', 'Rig': 'Equipo', 'Mobility': 'Movilidad', 'Area': 'Zona', 'Heading': 'Dirección'
    ,'Driver rating': 'Calificación del chofer', 'New driver': 'Chofer nuevo', 'Position': 'Posición', 'Size': 'Medida'
    ,'Problem': 'Problema', 'Equipment on this rig': 'Equipo de esta unidad', 'Exact spot': 'Ubicación exacta'
    ,'Distance': 'Distancia', 'view': 'ver', 'Showing': 'Mostrando', 'Spent on these': 'Gastado en estos'
    ,'Everyone signs in with their own mobile number — no passwords to hand out or reset': 'Cada persona inicia sesión con su propio celular — no hay contraseñas que entregar ni restablecer'
    ,'Add someone': 'Agregar a alguien', 'Name': 'Nombre', 'Role': 'Función', 'Yard': 'Base', 'Their language': 'Su idioma'
    ,'Technician — sees only the jobs you give them': 'Técnico — solo ve los trabajos que le asigna'
    ,'Dispatcher — gets lead alerts and hands work out': 'Despachador — recibe alertas y asigna el trabajo'
    ,'English': 'Inglés', 'Español (Spanish)': 'Español'
    ,'Their invite text and app arrive in this language. They can change it themselves later.': 'Su invitación y la aplicación llegan en este idioma. Después pueden cambiarlo.'
    ,'A dispatcher tied to a yard is only alerted for leads near that yard. Leave it on "Any yard" to hear about everything.': 'Un despachador asignado a una base solo recibe avisos cercanos a ella. Déjelo en “Cualquier base” para recibirlos todos.'
    ,'Remove': 'Quitar', 'Assign to…': 'Asignar a…', 'Rate this driver': 'Calificar a este chofer'
    ,'Did they pay, show up, answer the phone? Other shops see this before buying their leads.': '¿Pagó, se presentó y contestó el teléfono? Otros talleres ven esto antes de comprar sus avisos.'
    ,'Work you won — assign it to someone and watch it move': 'Trabajo que ganó — asígnelo y siga su progreso'
    ,'No live jobs. Buy a lead and win it and it lands here.': 'No hay trabajos activos. Compre y gane un aviso para verlo aquí.'
    ,'Completed': 'Completados', "Can't take it": 'No puedo atenderlo', 'Running late': 'Voy retrasado'
    ,"No jobs assigned to you yet. Your dispatcher will send one over — you'll get a text.": 'Aún no tiene trabajos asignados. Su despachador le enviará uno y recibirá un texto.'
    ,'Finished': 'Terminados', 'COMPLETE': 'COMPLETO', 'Performance on RIGRX': 'Rendimiento en RIGRX'
    ,'Leads bought — last 7 days': 'Avisos comprados — últimos 7 días', 'What these numbers mean': 'Qué significan estos números'
    ,'Win rate': 'Tasa de éxito', 'Cost per job won': 'Costo por trabajo ganado', 'Avg reply time': 'Tiempo promedio de respuesta'
    ,'What drivers said': 'Lo que dijeron los choferes'
    ,'Every rating left for you, and the job it came from': 'Todas las calificaciones que recibió y el trabajo correspondiente'
    ,'What they mention most': 'Lo que más mencionan', 'Company Settings': 'Configuración de la compañía'
    ,'What you do & where you cover controls which leads you see': 'Lo que hace y dónde trabaja determina los avisos que ve'
    ,'Company': 'Compañía', 'NO TRADE SET': 'SIN OFICIO DEFINIDO', 'No locations yet': 'Aún no hay ubicaciones'
    ,'Services offered': 'Servicios ofrecidos', 'No services selected yet': 'Aún no se seleccionan servicios'
    ,'Equipment & capabilities': 'Equipo y capacidades'
    ,'No capability flags set — you may be missing matching leads': 'No se indicaron capacidades — podría perder avisos compatibles'
    ,'Verification': 'Verificación', 'License': 'Licencia', 'Certificate of insurance': 'Certificado de seguro'
    ,'Spanish-speaking dispatch': 'Despacho que habla español', 'ON': 'SÍ', 'OFF': 'NO', 'Billing': 'Facturación'
    ,'The whole marketplace at a glance — click any number to see what’s behind it': 'Todo el mercado de un vistazo — haga clic en cualquier número para ver los detalles'
    ,'Nothing here was blocked — a driver stuck on the shoulder always gets his message through. This is what to follow up on.': 'Aquí no se bloqueó nada — un chofer varado siempre logra enviar su mensaje. Esto es lo que debe revisar.'
    ,'Companies flagged most': 'Compañías con más alertas', 'Needs review': 'Necesita revisión', 'Everything': 'Todo'
    ,'Everyone who has requested help — click for their full history': 'Todos los que pidieron ayuda — haga clic para ver su historial'
    ,'No drivers yet': 'Aún no hay choferes', 'Archived': 'Archivados', 'Nobody archived': 'Nadie archivado'
    ,'Contact': 'Contacto', 'Phone': 'Teléfono', 'Equipment on file': 'Equipo registrado', 'Nothing saved yet': 'Aún no hay nada guardado'
    ,'Requests': 'Solicitudes', 'No requests yet': 'Aún no hay solicitudes'
    ,'Click any company to see its full profile before you decide': 'Haga clic en una compañía para ver su perfil completo antes de decidir'
    ,'Waiting for review': 'En espera de revisión', 'Approved': 'Aprobadas', 'None yet': 'Aún ninguna'
    ,'Coverage waitlist': 'Lista de espera de cobertura', 'Nobody on the waitlist yet': 'Aún no hay nadie en la lista de espera'
    ,'Account phone': 'Teléfono de la cuenta', 'Dispatch': 'Despacho', 'After hours': 'Fuera de horario'
    ,'Capabilities claimed': 'Capacidades declaradas', 'None set': 'Ninguna indicada', 'License & documents': 'Licencia y documentos'
    ,'License #': 'Licencia #', 'Insurance (COI)': 'Seguro (COI)', 'Verified on': 'Verificado el'
    ,'not provided': 'no proporcionada', 'not uploaded': 'no cargado', 'open document ›': 'abrir documento ›'
    ,'Remove license verification': 'Quitar verificación de licencia', 'Free lead credits': 'Créditos de avisos gratis'
    ,'Balance': 'Saldo', 'Apply': 'Aplicar', 'Platform access': 'Acceso a la plataforma'
    ,'Suspend this company': 'Suspender esta compañía', 'Private notes (only you see these)': 'Notas privadas (solo usted las ve)'
    ,'Save notes': 'Guardar notas', 'Recent driver reviews': 'Reseñas recientes de choferes'
    ,'Lead Pricing': 'Precios de avisos', 'Standard $': 'Estándar $', 'Premium $': 'Premium $'
    ,'Lead Sales': 'Ventas de avisos', 'No sales yet': 'Aún no hay ventas'
    ,'Requested Services': 'Servicios solicitados', 'Nothing pending': 'Nada pendiente'
    ,'Dispatch Exceptions': 'Excepciones de despacho'
    ,'Requests and delivery failures that need a human decision — newest first': 'Solicitudes y fallas de entrega que requieren una decisión humana — las más recientes primero'
    ,'Alerts': 'Alertas', 'No open dispatch exceptions.': 'No hay excepciones de despacho abiertas.'
    ,'Notification delivery': 'Entrega de notificaciones'
    ,'Click any request to see everything in it, including all messages': 'Haga clic en una solicitud para ver todos sus datos y mensajes'
    ,'Nothing here': 'No hay nada aquí', 'No messages in this thread': 'No hay mensajes en esta conversación'
    ,'Who sent it': 'Quién la envió', 'What was in the request': 'Contenido de la solicitud'
    ,'Area shown': 'Zona mostrada', 'GPS': 'GPS', 'no description given': 'no se proporcionó descripción'
    ,'Equipment on the request': 'Equipo de la solicitud', 'Reviews from this job': 'Reseñas de este trabajo'
    ,'Who bought this lead': 'Quién compró este aviso', 'Other message threads': 'Otras conversaciones'
    ,'Everything here drives the app: what drivers can request, what companies can offer, and how the two get matched.': 'Todo esto controla la aplicación: lo que los choferes solicitan, lo que las compañías ofrecen y cómo se conectan.'
    ,'Add a category': 'Agregar una categoría', 'One-line description': 'Descripción en una línea'
    ,'Lead price $': 'Precio del aviso $', 'Premium 4th slot $': 'Cuarto espacio premium $', 'Icon': 'Ícono'
    ,"Show on the driver's request screen?": '¿Mostrar en la pantalla de solicitud del chofer?'
    ,'Providers only': 'Solo proveedores', 'DRIVERS SEE IT': 'VISIBLE PARA CHOFERES', 'PROVIDERS ONLY': 'SOLO PROVEEDORES'
    ,'No services under this category yet — add one below': 'Aún no hay servicios en esta categoría — agregue uno abajo'
    ,'Every time someone picks "Other…" and types their own answer, it lands here. Anything showing up repeatedly belongs in the built-in list.': 'Cada vez que alguien elige “Otro…” y escribe una respuesta, aparece aquí. Lo que se repita debe agregarse a la lista integrada.'
    ,'Nothing yet — the lists are covering everyone so far.': 'Nada todavía — las listas cubren todos los casos hasta ahora.'
    ,'Add a card': 'Agregar una tarjeta'
    ,'Charged only when you unlock a lead. You can replace it anytime.': 'Solo se cobra al desbloquear un aviso. Puede reemplazarla cuando quiera.'
    ,'Save card': 'Guardar tarjeta'
    ,'Card details go straight to Stripe — RIGRX never sees the number.': 'Los datos de la tarjeta van directamente a Stripe — RIGRX nunca ve el número.'
    ,'Card was not accepted': 'No se aceptó la tarjeta', 'card': 'tarjeta'
    ,'Card saved — {brand} ending {last4}': 'Tarjeta guardada — {brand} terminada en {last4}'
    ,'Could not load the card form — check your connection': 'No se pudo cargar el formulario de tarjeta — revise su conexión'
    ,'Stripe publishable key missing — add STRIPE_PUBLISHABLE_KEY to your secrets': 'Falta la clave pública de Stripe — agregue STRIPE_PUBLISHABLE_KEY a sus secretos'
    ,'Badge on — Spanish-speaking drivers will see it': 'Distintivo activado — los choferes hispanohablantes lo verán'
    ,'Badge off': 'Distintivo desactivado'
    ,'Enter a dollar amount': 'Ingrese un monto en dólares'
    ,'Quote sent': 'Cotización enviada'
    ,'Pick a city from the list — start typing and choose one': 'Elija una ciudad de la lista — empiece a escribir y selecciónela'
    ,'Location added — {radius} mi radius': 'Ubicación agregada — radio de {radius} mi'
    ,'"{name}" added — pending RIGRX approval': '“{name}” agregado — pendiente de aprobación de RIGRX'
    ,'Select at least one service': 'Seleccione al menos un servicio'
    ,'Pick what kind of company you are first': 'Primero elija qué tipo de compañía tiene'
    ,'Pick at least one truck size you work on': 'Elija al menos un tamaño de camión que atiende'
    ,'Uploaded': 'Archivo cargado'
    ,'Application submitted — pending RIGRX approval': 'Solicitud enviada — pendiente de aprobación de RIGRX'
    ,'Name and mobile number both needed': 'Se requieren el nombre y el número celular'
    ,'Remove {name} from your team?\n\nThey lose access immediately. Any job they had open goes back to your queue.': '¿Quitar a {name} de su equipo?\n\nPerderá el acceso de inmediato. Cualquier trabajo abierto volverá a su cola.'
    ,'Driver rated {stars}★ — thanks, this keeps the feed honest': 'Chofer calificado con {stars}★ — gracias, esto mantiene honestos los avisos'
    ,'Pick someone first': 'Primero elija a alguien'
    ,'Assigned — we texted them': 'Asignado — le enviamos un texto'
    ,'Hand this job back to your dispatcher?': '¿Devolver este trabajo a su despachador?'
    ,'Accepted': 'Aceptado'
    ,'Sent back to dispatch': 'Devuelto a despacho'
    ,'Driver has been told you arrived': 'Se avisó al chofer que usted llegó'
    ,'Driver notified — they can see your ETA counting down': 'Chofer avisado — puede ver la cuenta regresiva de su llegada'
    ,'Driver has been updated': 'Se actualizó al chofer'
    ,'Marked reviewed': 'Marcado como revisado'
    ,'Archive this {who}?\n\nThey will be signed out and locked out immediately, and will have to create a new account to come back. Nothing is deleted and you can restore them any time.': '¿Archivar a {who}?\n\nSu sesión se cerrará y perderá el acceso de inmediato; tendrá que crear otra cuenta para volver. No se elimina nada y puede restaurarlo cuando quiera.'
    ,'Archived — {n} open request closed': 'Archivado — se cerró {n} solicitud abierta'
    ,'Archived — {n} open requests closed': 'Archivado — se cerraron {n} solicitudes abiertas'
    ,'Restored — they can sign in again': 'Restaurado — ya puede iniciar sesión de nuevo'
    ,'Welcome button now grants {n} free lead': 'El botón de bienvenida ahora otorga {n} aviso gratis'
    ,'Welcome button now grants {n} free leads': 'El botón de bienvenida ahora otorga {n} avisos gratis'
    ,'Enter how many credits (use a minus sign to take back)': 'Ingrese cuántos créditos (use signo negativo para retirarlos)'
    ,'Balance is now {n} free lead': 'El saldo ahora es de {n} aviso gratis'
    ,'Balance is now {n} free leads': 'El saldo ahora es de {n} avisos gratis'
    ,'Provider approved & notified': 'Proveedor aprobado y avisado'
    ,'Provider suspended': 'Proveedor suspendido'
    ,'License verified — they now get licensed-only leads': 'Licencia verificada — ahora recibe avisos exclusivos para compañías con licencia'
    ,'License verification removed': 'Verificación de licencia eliminada'
    ,'Notes saved': 'Notas guardadas'
    ,'Price updated': 'Precio actualizado'
    ,'Approved and added to the catalog for everyone': 'Aprobado y agregado al catálogo para todos'
    ,'Exception resolved': 'Excepción resuelta'
    ,'Exception acknowledged': 'Excepción confirmada'
    ,'Notification delivered': 'Notificación entregada'
    ,'Retry queued': 'Reintento en cola'
    ,'Give the category a name': 'Asigne un nombre a la categoría'
    ,'"{label}" added — now add the services under it': '“{label}” agregada — ahora agregue sus servicios'
    ,'Test mode': 'Modo de prueba'
    ,'(no Twilio keys yet) — your code is': '(aún no hay claves de Twilio) — su código es'
    ,"Don't ask for the exact location here.": 'No pida aquí la ubicación exacta.'
    ,'You get the pin, the mile marker and turn-by-turn directions the second this driver picks you. Asking for it early is against the rules and gets flagged for review.': 'Recibirá la ubicación, el marcador de milla y las indicaciones en cuanto este chofer lo elija. Pedirlos antes va contra las reglas y se marca para revisión.'
    ,'Job closed — the driver has been asked to rate you': 'Trabajo cerrado — se pidió al chofer que lo califique'
    ,'How many more minutes?': '¿Cuántos minutos más?'
    ,'Saved changes were not restored because this information was updated elsewhere.': 'Los cambios guardados no se restauraron porque esta información se actualizó en otro lugar.'
    ,'You get the pin, the mile marker and turn-by-turn directions the second this driver picks you. Asking for it early is against the rules and gets flagged for review.': 'Recibirá el pin, el marcador de milla y las indicaciones paso a paso en cuanto el chofer lo elija. Pedirlos antes va contra las reglas y genera una alerta para revisión.'
    ,'Hold off on asking where they are': 'Espere antes de preguntar dónde está'
    ,"You get the exact pin, the mile marker and turn-by-turn directions the moment this driver picks you — you don't need to ask for them.": 'Recibirá el pin exacto, el marcador de milla y las indicaciones paso a paso en cuanto el chofer lo elija — no necesita pedirlos.'
    ,"Asking before you're chosen is against the RIGRX rules, and this message will be flagged for review. Quote from the distance and drive time on the lead instead.": 'Preguntar antes de ser elegido va contra las reglas de RIGRX y este mensaje se marcará para revisión. Cotice usando la distancia y el tiempo de viaje del aviso.'
    ,'Send anyway': 'Enviar de todos modos', 'Let me reword it': 'Quiero reformularlo'
    ,'+ Add location': '+ Agregar ubicación', 'Card on file:': 'Tarjeta registrada:'
    ,'RIGRX review': 'Revisión de RIGRX'
    ,'(usually same day). You can browse masked leads right away — buying unlocks once you’re approved.': '(normalmente el mismo día). Puede explorar avisos anónimos de inmediato — podrá comprar cuando sea aprobado.'
    ,'— unlocking a lead uses one automatically. No charge.': '— al desbloquear un aviso se usa uno automáticamente. Sin cargo.'
    ,"Your license isn't verified yet.": 'Su licencia aún no está verificada.'
    ,'and RIGRX will review it.': 'y RIGRX la revisará.'
    ,'premium slot only': 'solo espacio premium'
    ,'Wheel': 'Rin', 'The driver chose YOU for this job': 'El chofer lo eligió A USTED para este trabajo'
    ,'This unlock uses one — your card is not touched.': 'Este desbloqueo usa un crédito — no se cobra su tarjeta.'
    ,'Owner': 'Propietario'
    ,'runs the account — billing, coverage, services and this page.': 'administra la cuenta — facturación, cobertura, servicios y esta página.'
    ,'Dispatcher': 'Despachador'
    ,'gets the lead alerts for their yard, buys leads, talks to drivers and assigns jobs.': 'recibe alertas de su base, compra avisos, habla con choferes y asigna trabajos.'
    ,'(HAZMAT)': '(HAZMAT)'
    ,'How often the driver picked you after you bought. Chatting first and quoting a clear ETA is what moves this.': 'La frecuencia con que el chofer lo eligió después de comprar. Chatear primero y cotizar una llegada clara mejora este resultado.'
    ,"Total lead spend divided by jobs won. Compare it to what an average job is worth to you — that's whether RIGRX pays.": 'Gasto total en avisos dividido entre trabajos ganados. Compárelo con el valor promedio de un trabajo para saber si RIGRX le conviene.'
    ,'How long you take to message the driver after buying. The first company to respond wins most of the time.': 'Cuánto tarda en escribir al chofer después de comprar. La primera compañía en responder gana la mayoría de las veces.'
    ,'Turn this on if someone answering your dispatch line speaks Spanish. Spanish-speaking drivers see a "Hablamos español" badge next to your name when comparing responders — it wins jobs.': 'Actívelo si alguien que atiende despacho habla español. Los choferes hispanohablantes verán “Hablamos español” junto a su nombre al comparar compañías — ayuda a ganar trabajos.'
    ,'— used automatically before your card.': '— se usan automáticamente antes de su tarjeta.'
    ,'No card on file.': 'No hay tarjeta registrada.'
    ,"The whole marketplace at a glance — click any number to see what's behind it": 'Todo el mercado de un vistazo — haga clic en cualquier número para ver los detalles'
    ,'matched:': 'coincidencia:', 'warned first and sent it anyway': 'recibió una advertencia y lo envió de todos modos'
    ,'REVIEWED': 'REVISADO'
    ,"One flag is usually a shop that doesn't know the rules yet — a phone call fixes it. A pattern is something else.": 'Una alerta suele ser un taller que aún no conoce las reglas — una llamada lo resuelve. Un patrón repetido es diferente.'
    ,'ARCHIVED': 'ARCHIVADO', 'LICENSE VERIFIED': 'LICENCIA VERIFICADA', 'APPROVED': 'APROBADO'
    ,'NEEDS REVIEW': 'NECESITA REVISIÓN', 'LICENSE NOT VERIFIED': 'LICENCIA NO VERIFICADA'
    ,'Profile incomplete —': 'Perfil incompleto —', 'Profile complete': 'Perfil completo'
    ,'— every onboarding field is filled in.': '— todos los campos de registro están completos.'
    ,'No locations — they will never match a lead': 'Sin ubicaciones — nunca coincidirá con un aviso'
    ,'None selected': 'Ninguno seleccionado', 'Custom requests': 'Solicitudes personalizadas', 'Equipment': 'Equipo'
    ,'W-9': 'W-9'
    ,'Verified companies also receive requests from drivers who chose "licensed companies only." Approval and license verification are separate — an unlicensed company can still work on RIGRX.': 'Las compañías verificadas también reciben solicitudes de choferes que eligieron “solo compañías con licencia”. La aprobación y la verificación de licencia son independientes — una compañía sin licencia aún puede trabajar en RIGRX.'
    ,'Credits are spent automatically before their card is ever charged — this is how the "first leads free" beta offer is delivered. They get a text when you grant them. The welcome amount is set on the': 'Los créditos se usan automáticamente antes de cobrar la tarjeta — así se entrega la oferta beta de “primeros avisos gratis”. Reciben un texto cuando usted se los otorga. La cantidad de bienvenida se define en la página de'
    ,'page; the box below is for special cases.': 'Precios; el campo siguiente es para casos especiales.'
    ,'Approved companies see leads and can buy them. Suspending stops both immediately.': 'Las compañías aprobadas ven y pueden comprar avisos. Suspenderlas detiene ambas cosas de inmediato.'
    ,'Per service type — standard slots (×3) and the premium 4th slot': 'Por tipo de servicio — espacios estándar (×3) y cuarto espacio premium'
    ,'Beta welcome credits': 'Créditos de bienvenida beta'
    ,"What the one-tap welcome button on a company's page grants. Set it to 0 to hide the button — every grant is still manual, per company, and logged.": 'Lo que otorga el botón de bienvenida de la página de una compañía. Defínalo en 0 para ocultarlo — cada entrega sigue siendo manual, por compañía y registrada.'
    ,'Save': 'Guardar', 'WON THE JOB': 'GANÓ EL TRABAJO', 'REFUNDED': 'REEMBOLSADO'
    ,"Services companies asked for that you don't offer yet. Approving adds it to the category you pick, so every company can then select it.": 'Servicios que pidieron las compañías y que aún no ofrece. Al aprobar uno, se agrega a la categoría elegida para que todas las compañías puedan seleccionarlo.'
    ,'Request': 'Solicitud', 'LICENSED ONLY': 'SOLO CON LICENCIA'
    ,'APPROXIMATE MANUAL LOCATION': 'UBICACIÓN MANUAL APROXIMADA', 'WON': 'GANÓ'
    ,'"Other" answers — what the dropdowns are missing': 'Respuestas “Otro” — lo que falta en las listas'
    ,'Field': 'Campo', 'What they typed': 'Lo que escribieron', 'Times': 'Veces', 'Last seen': 'Visto por última vez'
    ,'Add': 'Agregar', 'Email': 'Correo', 'RIGRX Admin': 'Administración de RIGRX'
    ,"(usually same day). You can browse masked leads right away — buying unlocks once you're approved.": '(normalmente el mismo día). Puede explorar avisos anónimos de inmediato — podrá comprar cuando sea aprobado.'
    ,'Companies who found the recruiting page from outside a live area. Where they cluster is where to open next.': 'Compañías que encontraron la página de reclutamiento fuera de una zona activa. Sus concentraciones indican dónde abrir después.'
    ,'Nobody bought this lead — it was alerted to {n} companies': 'Nadie compró este aviso — se avisó a {n} compañías'
    ,'prem $': 'premium $'

    // ---- API and server errors surfaced in the browser ----
    ,'Sign in required': 'Debe iniciar sesión'
    ,'Too many codes requested for this number. Try again in an hour, or call RIGRX if you are stuck.': 'Se solicitaron demasiados códigos para este número. Inténtelo de nuevo en una hora o llame a RIGRX si necesita ayuda.'
    ,'We just sent a code — give it 30 seconds to arrive before requesting another.': 'Acabamos de enviar un código — espere 30 segundos antes de solicitar otro.'
    ,'Too many wrong attempts. Request a fresh code.': 'Demasiados intentos incorrectos. Solicite un código nuevo.'
    ,'RIGRX_ALLOW_SIMULATION cannot be enabled in production.': 'RIGRX_ALLOW_SIMULATION no puede estar activado en producción.'
    ,'SESSION_SECRET must be at least 32 characters.': 'SESSION_SECRET debe tener al menos 32 caracteres.'
    ,'The current assignment version is required': 'Se requiere la versión actual de la asignación'
    ,'A valid assignment command key is required': 'Se requiere una clave válida para la orden de asignación'
    ,'This company account is no longer active': 'Esta cuenta de compañía ya no está activa'
    ,'That assignment command belongs to another action': 'Esa orden de asignación pertenece a otra acción'
    ,'Not one of your jobs': 'Este trabajo no le pertenece'
    ,'Pick an active technician on your team': 'Elija un técnico activo de su equipo'
    ,'This job can no longer be assigned': 'Este trabajo ya no se puede asignar'
    ,'This job changed. Refresh before assigning it again.': 'Este trabajo cambió. Actualice antes de volver a asignarlo.'
    ,'Unknown job action': 'Acción de trabajo desconocida'
    ,'This job assignment is stale. Refresh your jobs.': 'Esta asignación está desactualizada. Actualice sus trabajos.'
    ,'A valid status update key is required': 'Se requiere una clave válida para actualizar el estado'
    ,'That status update key belongs to another action': 'Esa clave de actualización pertenece a otra acción'
    ,'Job not found': 'No se encontró el trabajo'
    ,'This technician account is no longer active': 'Esta cuenta de técnico ya no está activa'
    ,'This job is no longer assigned to you': 'Este trabajo ya no está asignado a usted'
    ,'This job belongs to another company': 'Este trabajo pertenece a otra compañía'
    ,'Driver not found': 'No se encontró al chofer'
    ,'Request not found': 'No se encontró la solicitud'
    ,'This job assignment changed. Try completing it again.': 'La asignación de este trabajo cambió. Intente completarlo de nuevo.'
    ,'The technician must arrive before this job can be completed': 'El técnico debe llegar antes de que se pueda completar este trabajo'
    ,'This technician is on scene. Complete or hand off the job before removing their access.': 'Este técnico está en el lugar. Complete o transfiera el trabajo antes de quitarle el acceso.'
    ,'This technician belongs to another company': 'Este técnico pertenece a otra compañía'
    ,'This driver account is no longer active': 'Esta cuenta de chofer ya no está activa'
    ,'This driver has a job already on the way or on scene. Complete it before archiving the account.': 'Este chofer ya tiene un trabajo en camino o en el lugar. Complételo antes de archivar la cuenta.'
    ,'Something went wrong on our end': 'Algo salió mal de nuestro lado'
    ,'This company account is not active': 'Esta cuenta de compañía no está activa'
    ,'Your account is pending RIGRX approval': 'Su cuenta está pendiente de aprobación de RIGRX'
    ,'This driver requested licensed companies only': 'Este chofer solicitó únicamente compañías con licencia'
    ,'This driver asked for a different kind of company': 'Este chofer solicitó otro tipo de compañía'
    ,'You have not marked that you service this size of truck': 'No indicó que atiende este tamaño de camión'
    ,'Lead not found': 'No se encontró el aviso'
    ,'This lead purchase was refunded and cannot be purchased again': 'La compra de este aviso fue reembolsada y no puede volver a comprarse'
    ,'Lead is no longer open': 'El aviso ya no está abierto'
    ,'Lead sold out (4 responders max)': 'Aviso agotado (máximo 4 compañías)'
    ,'Lead credit was already used; try again': 'El crédito del aviso ya se utilizó; inténtelo de nuevo'
    ,'No card on file. Add one in Settings → Billing to keep buying leads.': 'No hay tarjeta registrada. Agregue una en Configuración → Facturación para seguir comprando avisos.'
    ,'This payment attempt was superseded by a newer retry.': 'Este intento de pago fue reemplazado por un reintento más reciente.'
    ,'Payment status is still being checked. This purchase will resume safely.': 'Aún se está verificando el estado del pago. Esta compra continuará de forma segura.'
    ,'Your card could not be charged — update it in Settings → Billing and try again.': 'No se pudo cobrar su tarjeta — actualícela en Configuración → Facturación e inténtelo de nuevo.'
    ,'Your card was declined — update it in Settings → Billing and try again.': 'Su tarjeta fue rechazada — actualícela en Configuración → Facturación e inténtelo de nuevo.'
    ,'Request not open': 'La solicitud no está abierta'
    ,'Choose a service company that purchased this active request': 'Elija una compañía de servicio que haya comprado esta solicitud activa'
    ,'Purchase not found': 'No se encontró la compra'
    ,'Only completed purchases can be refunded': 'Solo se pueden reembolsar compras completadas'
    ,'This company is assigned to the job. Cancel or reassign the job before refunding its lead.': 'Esta compañía está asignada al trabajo. Cancele o reasigne el trabajo antes de reembolsar su aviso.'
    ,'No destination phone number': 'No hay un número de teléfono de destino'
    ,'SMS delivery is not configured': 'El envío de SMS no está configurado'
    ,'Payments are not configured': 'Los pagos no están configurados'
    ,'No card on file — add one in Settings': 'No hay tarjeta registrada — agregue una en Configuración'
    ,'Payment already succeeded and must be refunded': 'El pago ya se completó y debe reembolsarse'
    ,'File not found': 'No se encontró el archivo'
    ,'No access to this file': 'No tiene acceso a este archivo'
    ,'Name required': 'Se requiere el nombre'
    ,'Not found': 'No se encontró'
    ,'lat/lng required': 'Se requieren latitud y longitud'
    ,'Company name is required': 'Se requiere el nombre de la compañía'
    ,'Leave a phone number or an email so we can reach you': 'Deje un número de teléfono o correo para que podamos comunicarnos'
    ,'Enter a valid phone number': 'Ingrese un número de teléfono válido'
    ,'Wrong or expired code': 'Código incorrecto o vencido'
    ,'This account has been closed. Contact RIGRX if you think that is a mistake.': 'Esta cuenta fue cerrada. Comuníquese con RIGRX si cree que se trata de un error.'
    ,'Unknown service type': 'Tipo de servicio desconocido'
    ,'Location required': 'Se requiere la ubicación'
    ,'You already have 3 open requests': 'Ya tiene 3 solicitudes abiertas'
    ,'Location time is invalid. Capture it again or enter a town.': 'La hora de la ubicación no es válida. Vuelva a capturarla o ingrese un pueblo.'
    ,'That GPS location is stale. Capture it again or enter your location by hand.': 'Esa ubicación GPS está desactualizada. Vuelva a capturarla o ingrese su ubicación manualmente.'
    ,'Add a landmark or mile marker when entering location by hand.': 'Agregue una referencia o marcador de milla al ingresar la ubicación manualmente.'
    ,'Choose a service company': 'Elija una compañía de servicio'
    ,'Nothing to widen': 'No hay nada que ampliar'
    ,'Wait two minutes before alerting companies again': 'Espere dos minutos antes de volver a avisar a las compañías'
    ,'This job is already moving or no longer active': 'Este trabajo ya está en marcha o dejó de estar activo'
    ,'This job is already moving or cannot be reopened': 'Este trabajo ya está en marcha o no se puede reabrir'
    ,'A job already on the way cannot be cancelled here': 'Un trabajo que ya está en camino no se puede cancelar aquí'
    ,'provider account required': 'Se requiere una cuenta de proveedor'
    ,'driver account required': 'Se requiere una cuenta de chofer'
    ,'admin account required': 'Se requiere una cuenta de administrador'
    ,'{role} account required': 'Se requiere una cuenta de {role}'
    ,'Only the account owner can change this': 'Solo el propietario de la cuenta puede cambiar esto'
    ,'Technicians see their assigned jobs only. Ask your dispatcher.': 'Los técnicos solo ven sus trabajos asignados. Consulte a su despachador.'
    ,'An active technician account is required': 'Se requiere una cuenta de técnico activa'
    ,'An active, assignable team account is required': 'Se requiere una cuenta de equipo activa y asignable'
    ,'Rate the driver after the job is done': 'Califique al chofer después de terminar el trabajo'
    ,'You already rated this driver': 'Ya calificó a este chofer'
    ,'Enter their name': 'Ingrese su nombre'
    ,'There can only be one owner': 'Solo puede haber un propietario'
    ,'Not on your team': 'No pertenece a su equipo'
    ,'The owner cannot be changed here': 'El propietario no se puede cambiar aquí'
    ,'You cannot remove the owner': 'No puede quitar al propietario'
    ,'You cannot archive an admin account': 'No puede archivar una cuenta de administrador'
    ,'Already archived': 'Ya está archivado'
    ,'No access to this thread': 'No tiene acceso a esta conversación'
    ,'Empty message': 'El mensaje está vacío'
    ,'You can review after a provider is chosen': 'Puede dejar una reseña después de elegir un proveedor'
    ,'Only the driver and chosen provider can review this job': 'Solo el chofer y el proveedor elegido pueden reseñar este trabajo'
    ,'You already reviewed this job': 'Ya dejó una reseña de este trabajo'
    ,'Choose acknowledge or resolve': 'Elija confirmar o resolver'
    ,'The exception revision is required': 'Se requiere la revisión de la excepción'
    ,'This exception changed. Refresh the queue before updating it.': 'Esta excepción cambió. Actualice la cola antes de modificarla.'
    ,'Notification is not retryable': 'La notificación no se puede volver a intentar'
    ,'Enter a number': 'Ingrese un número'
    ,'How many credits?': '¿Cuántos créditos?'
    ,'Payments are in simulation mode — no Stripe keys are set yet': 'Los pagos están en modo de simulación — aún no se configuraron las claves de Stripe'
    ,'Complete your company profile first': 'Primero complete el perfil de su compañía'
    ,'Could not start card setup': 'No se pudo iniciar la configuración de la tarjeta'
    ,'Payments are in simulation mode': 'Los pagos están en modo de simulación'
    ,'Card setup incomplete': 'La configuración de la tarjeta está incompleta'
    ,"That card didn't save — try again": 'No se guardó esa tarjeta — inténtelo de nuevo'
    ,'Only photos (JPG, PNG, WebP, HEIC) and PDFs can be uploaded': 'Solo se pueden cargar fotos (JPG, PNG, WebP, HEIC) y archivos PDF'
    ,'Use a file uploaded through RIGRX': 'Use un archivo cargado mediante RIGRX'
    ,'That upload does not belong to this account': 'Ese archivo cargado no pertenece a esta cuenta'
    ,'Breakdown photos must be images': 'Las fotos de la avería deben ser imágenes'
    ,'Choose a location owned by this company': 'Elija una ubicación que pertenezca a esta compañía'
    ,'That number belongs to a protected administrator account': 'Ese número pertenece a una cuenta de administrador protegida'
    ,'That number is already registered with a different account type': 'Ese número ya está registrado con otro tipo de cuenta'
    ,'That number already belongs to another company': 'Ese número ya pertenece a otra compañía'
    ,'The company owner cannot be changed into a team member': 'El propietario de la compañía no se puede convertir en miembro del equipo'
    ,'Cannot {action} a job while it is {state}': 'No se puede ejecutar “{action}” en un trabajo con estado “{state}”'
    ,'Payment requires attention ({status})': 'El pago requiere atención ({status})'
    ,'Payment did not complete ({status})': 'El pago no se completó ({status})'
    ,'Refund {status}': 'Reembolso: {status}'
    ,'Refund is {status}': 'El estado del reembolso es {status}'
    ,'Missing required configuration: {config}. {hint}': 'Falta la configuración obligatoria: {config}. {hint}'
    ,'This purchase is not available to retry': 'Esta compra no está disponible para volver a intentarla'
    ,'Payment failed': 'El pago falló'
    ,'Payment status unavailable': 'El estado del pago no está disponible'
    ,'Refund failed': 'El reembolso falló'
    ,'Refund status is still being checked and will resume safely.': 'Aún se está verificando el estado del reembolso y continuará de forma segura.'
    ,'accept': 'aceptar', 'decline': 'rechazar', 'enroute': 'en camino'
    ,'late': 'retrasado', 'arrived': 'en el lugar', 'complete': 'completar'
    ,'assigned': 'asignado', 'accepted': 'aceptado', 'unassigned': 'sin asignar'
    ,'pending': 'pendiente', 'failed': 'fallido', 'succeeded': 'completado'
    ,'requires_action': 'requiere una acción', 'requires_payment_method': 'requiere otro método de pago'
    ,'{n} mi radius': 'radio de {n} mi'
    ,'Start typing any US city — e.g. Amarillo, TX': 'Empiece a escribir cualquier ciudad de EE. UU. — p. ej., Amarillo, TX'
    ,'Bakersfield — HQ': 'Bakersfield — sede'
    ,'e.g. Mobile alignment': 'p. ej., alineación móvil'
    ,'No / Yes — 60 ton': 'No / Sí — 60 toneladas'
    ,'Submit & open my dashboard': 'Enviar y abrir mi panel'
    ,'Any yard': 'Cualquier base'
    ,'Yard {id}': 'Base {id}'
    ,'Add to team & text them the link': 'Agregar al equipo y enviarle el enlace por mensaje'
    ,'any yard': 'cualquier base'
    ,'can be assigned jobs': 'puede recibir trabajos'
    ,'sees only the jobs assigned to them — never the lead feed, never what anything cost.': 'solo ve los trabajos que se le asignan; nunca ve los prospectos ni cuánto costó nada.'
    ,'{name} added — we texted them a sign-in link': 'Se agregó a {name}; le enviamos por mensaje un enlace para iniciar sesión'
    ,'Removed': 'Eliminado'
    ,'Removed — {n} job back in the queue': 'Eliminado — {n} trabajo volvió a la cola'
    ,'Removed — {n} jobs back in the queue': 'Eliminado — {n} trabajos volvieron a la cola'
    ,'{trade} — typical services checked, adjust anything below': '{trade} — marcamos los servicios habituales; ajuste lo que necesite abajo'
    ,'Services offered ({n})': 'Servicios ofrecidos ({n})'
    ,"Your account goes to RIGRX review (usually same day). You can browse masked leads right away — buying unlocks once you're approved.": 'Su cuenta pasa a revisión de RIGRX (normalmente el mismo día). Puede consultar avisos con datos ocultos de inmediato; las compras se habilitan cuando se apruebe.'
    ,'Account pending RIGRX approval — you can browse masked leads, but buying unlocks after approval.': 'Cuenta pendiente de aprobación de RIGRX: puede consultar avisos con datos ocultos, pero las compras se habilitan después de la aprobación.'
    ,'unlocking a lead uses one automatically. No charge.': 'al desbloquear un aviso se usa uno automáticamente. Sin cargo.'
    ,'You missed {n} this week from drivers who asked for licensed companies only.': 'Esta semana no recibió {n} de choferes que pidieron únicamente empresas con licencia.'
    ,'Some drivers request licensed companies only, and those leads stay hidden from you.': 'Algunos choferes solicitan únicamente empresas con licencia, y esos avisos no se le muestran.'
    ,'Add your license number and insurance in Settings and RIGRX will review it.': 'Agregue su número de licencia y seguro en Configuración y RIGRX los revisará.'
    ,'text': 'mensaje de texto', 'live alert the second a matching lead drops': 'alerta en vivo en cuanto aparece un aviso compatible'
    ,'hazmat': 'materiales peligrosos', '{band} from you': 'a {band} de usted'
    ,'Open': 'Abrir', 'Force in {price}': 'Entrar por {price}', '{n} of 3 slots left': 'quedan {n} de 3 lugares'
    ,'Unlock {price}': 'Desbloquear por {price}', 'All leads': 'Todos los avisos', 'posted': 'publicado'
    ,'respond fast to win the job': 'responda rápido para ganar el trabajo', 'Hazmat': 'Materiales peligrosos'
    ,'Yes — Class {class}, UN {un}': 'Sí — Clase {class}, UN {un}', '{rating} as rated by providers': '{rating}, según empresas de servicio'
    ,'The failed tire': 'La llanta averiada', 'not on file': 'no registrado'
    ,'Approximate town entered manually — confirm the landmark with the driver.': 'Ciudad aproximada ingresada manualmente; confirme el punto de referencia con el chofer.'
    ,'{miles} mi · about {minutes} min': '{miles} mi · unos {minutes} min', 'add a location in Settings': 'agregue una ubicación en Configuración'
    ,'unlocks if the driver picks you': 'se desbloquea si el chofer lo elige', 'Unlocks when you buy': 'Se desbloquea al comprar'
    ,'Driver name & direct phone number': 'Nombre y teléfono directo del chofer'
    ,'Exact GPS pin + landmark / mile marker': 'Punto GPS exacto y referencia o marcador de milla'
    ,'Full truck & trailer specs + photos': 'Datos completos del camión y remolque, más fotos'
    ,'Instant in-app chat with the driver': 'Chat inmediato con el chofer dentro de la aplicación'
    ,'Message the driver now': 'Enviar mensaje al chofer ahora', 'UNLOCK FREE — 1 CREDIT': 'DESBLOQUEAR GRATIS — 1 CRÉDITO'
    ,'Nobody accepted this — it came back to you. Reassign it.': 'Nadie aceptó este trabajo; volvió a usted. Reasígnelo.'
    ,'Nobody on your team can be assigned work yet. Add your techs in Your team.': 'Todavía nadie de su equipo puede recibir trabajos. Agregue técnicos en Su equipo.'
    ,'Accept this job': 'Aceptar este trabajo'
    ,'Approximate manual location — call the driver to confirm the exact spot.': 'Ubicación manual aproximada; llame al chofer para confirmar el punto exacto.'
    ,'HAZMAT': 'MAT. PELIGROSOS', 'ETA min': 'Llegada en min', 'On my way': 'Voy en camino'
    ,'Driver is expecting you in about {n} min': 'El chofer lo espera en unos {n} min', "I've arrived": 'Ya llegué'
    ,'Job complete': 'Trabajo terminado', 'Finished ({n})': 'Terminados ({n})'
    ,'No reviews yet. Drivers are asked to rate you after they mark the job complete — the fastest way to your first one is to win a job and do it well.': 'Aún no hay reseñas. Se pide a los choferes que lo califiquen al marcar el trabajo como terminado; la forma más rápida de obtener la primera es ganar un trabajo y hacerlo bien.'
    ,'(add it)': '(agregar)', 'uploaded': 'subido', '(upload)': '(subir)'
    ,'used automatically before your card.': 'se usan automáticamente antes de cobrar a su tarjeta.'
    ,'Payment simulation mode — no card needed yet': 'Modo de simulación de pagos; todavía no se necesita tarjeta'
    ,'Once your free leads run out you will need one to keep buying.': 'Cuando se terminen sus avisos gratis necesitará una para seguir comprando.'
    ,'Premium $': 'Premium $', '{total} from {sales} · click a sale to open the request behind it': '{total} de {sales} · haga clic en una venta para abrir la solicitud correspondiente'
    ,'from': 'de', 'driver': 'chofer', 'slot': 'lugar', 'premium': 'premium', 'by': 'por'
    ,'Add under {category}': 'Agregar en {category}', 'opened': 'abierto', 'Waiting to retry': 'Esperando para reintentar'
    ,'{n} notified': '{n} notificados', '{n} bought': '{n} compraron', 'All requests': 'Todas las solicitudes'
    ,'{amount} revenue': '{amount} de ingresos', 'unnamed': 'sin nombre', 'rated {rating} by providers': 'calificado con {rating} por empresas'
    ,'GPS': 'GPS', 'Who bought this lead ({n} of 4)': 'Quién compró este aviso ({n} de 4)'
    ,'Auto Glass Repair': 'Reparación de vidrios', 'Windshields, chips, mirrors': 'Parabrisas, impactos, espejos'
    ,'Add category': 'Agregar categoría', 'no price': 'sin precio', 'no description': 'sin descripción', 'key': 'clave'
    ,'Add a service, e.g. Windshield replacement': 'Agregue un servicio, p. ej., reemplazo de parabrisas'
    ,'Categories get turned off rather than deleted, so past requests keep their labels and your revenue reports stay intact. A new category reaches nobody until service companies check something under it — so add them as demand shows up.': 'Las categorías se desactivan en vez de eliminarse, para conservar las etiquetas de solicitudes anteriores y los informes de ingresos. Una categoría nueva no llega a nadie hasta que las empresas marquen algún servicio; agréguelos según aparezca la demanda.'
    ,'{n} free lead on your account': '{n} aviso gratis en su cuenta', '{n} free leads on your account': '{n} avisos gratis en su cuenta'
    ,'{n} lead': '{n} aviso', '{n} leads': '{n} avisos'
    ,'{n} free lead on your account.': '{n} aviso gratis en su cuenta.', '{n} free leads on your account.': '{n} avisos gratis en su cuenta.'
    ,'{n} free lead remaining': 'queda {n} aviso gratis', '{n} free leads remaining': 'quedan {n} avisos gratis'
    ,'{n} sale': '{n} venta', '{n} sales': '{n} ventas', '{n} company': '{n} empresa', '{n} companies': '{n} empresas'
    ,'{n} attempt': '{n} intento', '{n} attempts': '{n} intentos'
    ,'Open {company}': 'Abrir {company}', 'company': 'empresa', 'Mark reviewed': 'Marcar como revisado', 'Unknown': 'Desconocido'
    ,'{amount} earned': '{amount} generados', '(no name)': '(sin nombre)', 'License:': 'Licencia:', 'none given': 'no indicada'
    ,'Waiting for review ({n})': 'En espera de revisión ({n})', 'Approved ({n})': 'Aprobadas ({n})'
    ,'Coverage waitlist ({n} not yet contacted)': 'Lista de espera de cobertura ({n} aún sin contactar)'
    ,'no location given': 'sin ubicación indicada', 'business name': 'nombre comercial', 'dispatch phone': 'teléfono de despacho'
    ,'dispatch email': 'correo de despacho', 'service location': 'ubicación de servicio', 'services offered': 'servicios ofrecidos'
    ,'license number': 'número de licencia', 'certificate of insurance': 'certificado de seguro', 'All providers': 'Todas las empresas'
    ,'Signed up {when} · {leads} · {amount} spent': 'Se registró {when} · {leads} · {amount} gastados'
    ,'Profile incomplete — missing: {items}. You can still approve them; drivers just see less.': 'Perfil incompleto; falta: {items}. Aun así puede aprobarlo; los choferes simplemente verán menos información.'
    ,'Profile complete — every onboarding field is filled in.': 'Perfil completo: todos los campos de incorporación están llenos.'
    ,'Coverage ({n})': 'Cobertura ({n})', 'open document': 'abrir documento', 'W-9': 'W-9'
    ,'Mark license as verified': 'Marcar licencia como verificada'
    ,'Credits are spent automatically before their card is ever charged — this is how the "first leads free" beta offer is delivered. They get a text when you grant them. The welcome amount is set on the Pricing page; the box below is for special cases.': 'Los créditos se usan automáticamente antes de cobrar la tarjeta; así se entrega la oferta beta de primeros avisos gratis. Reciben un mensaje cuando usted se los otorga. El monto de bienvenida se configura en la página de Precios; el campo siguiente es para casos especiales.'
    ,'e.g. spoke with the owner, insurance checks out': 'p. ej., hablé con el dueño; el seguro está en orden'
    ,'{n} flag': '{n} marca', '{n} flags': '{n} marcas'
    ,'Lead #': 'Aviso #', 'bought': 'comprado'
    // v24 merge additions
    ,'Nobody has been alerted yet': 'Aún no se ha avisado a nadie'
    ,'No approved company in range offers this service yet.': 'Ninguna compañía aprobada en su área ofrece este servicio todavía.'
    ,"RIGRX has been alerted and is working on it. You can also blast every approved company nearby — even ones that don't list this service. One of them may still help, or know who can.": 'RIGRX ya fue avisado y está trabajando en ello. También puede avisar a todas las compañías aprobadas cercanas — incluso las que no ofrecen este servicio. Alguna podría ayudar, o conocer a quien pueda.'
    ,'Alert every approved company nearby': 'Avisar a todas las compañías aprobadas cercanas'
    ,'Still nobody in range — RIGRX has been alerted and will help find someone': 'Aún no hay nadie en su área — RIGRX fue avisado y ayudará a encontrar a alguien'
    ,'You were signed out — sign in again': 'Se cerró su sesión — inicie sesión de nuevo'
    ,'+{n} more ›': '+{n} más ›', 'Edit profile': 'Editar perfil'
    ,'License plate (optional)': 'Placa (opcional)'
    ,'Service companies — how RIGRX gets you jobs ›': 'Compañías de servicio — cómo RIGRX les consigue trabajos ›'
    ,'Pending RIGRX approval.': 'Pendiente de aprobación de RIGRX.'
    ,"You can browse masked leads now; buying unlocks the moment you're approved — usually within a day.": 'Ya puede ver avisos con datos ocultos; la compra se activa en cuanto lo aprueben — normalmente en un día.'
    ,"It's yours — hit On my way when you roll": 'Es suyo — toque Voy en camino cuando salga'
    ,"This one's yours": 'Este es suyo'
    ,'{name} added — test mode, so no text went out. Tell them to sign in with their number.': 'Se agregó a {name} — modo de prueba, no se envió mensaje. Dígale que inicie sesión con su número.'
    ,'— optional, needed for the LICENSED badge': '— opcional, se necesita para la insignia CON LICENCIA'
    ,'License verified — you receive licensed-only leads': 'Licencia verificada — usted recibe avisos solo con licencia'
    ,'License on file — awaiting RIGRX verification': 'Licencia registrada — en espera de verificación de RIGRX'
    ,'No license on file — you miss licensed-only leads': 'Sin licencia registrada — se pierde los avisos solo con licencia'
    ,'Approved — you can buy leads': 'Aprobado — ya puede comprar avisos'
    ,'Pending RIGRX review': 'Pendiente de revisión de RIGRX'
    ,'Approve — allow them to buy leads': 'Aprobar — permitirles comprar avisos'
    ,'UNLOCK LEAD': 'DESBLOQUEAR AVISO', 'FORCE IN': 'FORZAR ENTRADA'
    ,'Location needs a refresh': 'Hay que actualizar la ubicación'
    ,'✓ Uploaded — replace': '✓ Subido — reemplazar'
    ,'+ Upload COI': '+ Subir certificado de seguro', '+ Upload W-9': '+ Subir W-9'
    ,'payments are in simulation mode until Stripe keys are added — no card needed to test.': 'los pagos están en modo de simulación hasta agregar las claves de Stripe — no se necesita tarjeta para probar.'
    ,'you will be asked for a card before your first lead purchase.': 'se le pedirá una tarjeta antes de su primera compra de aviso.'
    ,'Tap Accept, then keep the driver posted': 'Toque Aceptar y mantenga informado al chofer'
    ,'Nothing assigned right now': 'Nada asignado por ahora'
    ,'Hide archived': 'Ocultar archivados', 'Show archived': 'Mostrar archivados'
    ,'Mark not contacted': 'Marcar como no contactado', 'Mark contacted': 'Marcar como contactado'
    ,'Hide from drivers': 'Ocultar a los choferes', 'Show to drivers': 'Mostrar a los choferes'
    ,'Turn off': 'Apagar', 'Turn on': 'Encender'
  };

  const DICTS = { es };

  LANG = detectLang();

  const api = { T, TN, setLang, getLang };
  if (typeof window !== 'undefined') Object.assign(window, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
