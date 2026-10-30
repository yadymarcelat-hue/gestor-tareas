# Proyectos

Gestor de proyectos y tareas con inicio de sesión propio. Las personas entran con correo y contraseña; solo pueden entrar quienes la administradora invite.

- **Frontend:** la app (`public/app.html`) más las páginas de ingreso (`/login`) y de crear contraseña (`/aceptar`).
- **Backend:** Next.js en Vercel, solo para dos rutas: `/api/config` y `/api/invite`.
- **Base de datos, login y archivos:** Supabase.

## Empresas y acceso

La plataforma tiene **empresas** (espacios de trabajo). Cada empresa tiene sus propios proyectos, hitos, tareas, archivos y equipo, y nadie ve lo de otra empresa. La base de datos lo controla, no solo la pantalla.

| Rol | Qué puede hacer |
|---|---|
| **Dueña de la plataforma** (la primera cuenta creada) | Crear empresas e invitar a su primera administradora. Ver la lista de empresas (nombre, número de personas, quién administra). Solo ve los proyectos de una empresa si se incluye en ella. |
| **Administradora de una empresa** | Crear proyectos e hitos, e invitar y quitar personas de su empresa |
| **Miembro** | Crear y mover tareas, subtareas, comentarios y archivos en los proyectos donde está |

Cómo se agrega una empresa:
1. La dueña entra a **Empresas**, escribe el nombre de la empresa y el nombre y correo de quien la administra, y pulsa **Crear empresa**.
2. La app da un enlace. Se lo envías a esa persona; al abrirlo crea su contraseña y entra como administradora de su empresa.
3. Ella invita a su equipo desde **Equipo**.

Una persona puede estar en varias empresas. Cambia de una a otra con el nombre de la empresa, arriba a la izquierda. Si ya tenía cuenta, no recibe enlace nuevo: entra con su contraseña de siempre y ve la empresa nueva.

## Puesta en marcha (unos 20 minutos)

### 1. Crear el proyecto en Supabase
1. Entra a [supabase.com](https://supabase.com) y crea un proyecto nuevo (el plan gratis sirve).
2. Ve a **SQL Editor**, pega todo el archivo `supabase/1-esquema.sql` y pulsa **Run**.

### 2. Configurar el inicio de sesión
En **Authentication > URL Configuration**:
- **Site URL:** la dirección de tu app en Vercel, por ejemplo `https://proyectos-ingenio.vercel.app`. Puedes ponerla después del paso 5.
- **Redirect URLs:** agrega `https://TU-DOMINIO/aceptar`. Mientras pruebas en tu computador, agrega también `http://localhost:3000/aceptar`.

En **Authentication > Providers > Email**, deja Email activado.

En **Authentication > Sign In / Providers**, desactiva **Allow new users to sign up**. Así nadie puede crearse una cuenta sin invitación. Las invitaciones siguen funcionando.

### 3. Crear tu usuario de administradora
En **Authentication > Users > Add user > Create new user**:
- Correo: `yady.marcelat@gmail.com`
- Contraseña: la que quieras
- Marca **Auto Confirm User**

Por ser la primera cuenta, queda como administradora.

### Si ya tenías instalada la versión de una sola empresa
1. En Supabase, abre **SQL Editor**, pega `supabase/3-actualizar-a-empresas.sql` y pulsa **Run**. Tus datos quedan en la empresa "Ingenio SAS" y tú como dueña de la plataforma.
2. Sube a GitHub los archivos nuevos y cambiados. Vercel publica solo.

Haz los dos pasos seguidos: mientras uno esté hecho y el otro no, la app no carga.

### 4. Pasar los datos que tenías
En **SQL Editor**, pega `supabase/2-migracion-datos.sql` y pulsa **Run**. Copia los proyectos Quicktrack y Solucionsoft, sus 4 hitos y sus 8 tareas, y los deja a tu nombre.

### 5. Publicar en Vercel
1. Sube esta carpeta a un repositorio de GitHub. Sin `node_modules` ni `.next`; el `.gitignore` ya los excluye.
2. En [vercel.com](https://vercel.com) elige **Add New > Project** e importa el repositorio. Vercel detecta Next.js solo.
3. En **Settings > Environment Variables** agrega las de `.env.example`:
   - `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY`: en Supabase, **Project Settings > API**.
   - `SUPABASE_SERVICE_ROLE_KEY`: en el mismo lugar, la llave **service_role**. Es secreta: solo va en Vercel, nunca en el código.
   - `APP_URL` (opcional): la dirección pública de la app.

   Si conectas Supabase con la integración de Vercel (**Storage > Supabase**), las tres primeras se crean solas.
4. Pulsa **Deploy**. Cuando termine, vuelve al paso 2 y pon la dirección real en Site URL y en Redirect URLs.

Para abrirlo en **v0**: importa el mismo repositorio de GitHub desde v0. Las variables de entorno se configuran igual.

### 6. Probar
1. Entra a `https://TU-DOMINIO/login` con tu correo y contraseña.
2. Ve a **Equipo**, invita a alguien y abre el enlace en una ventana de incógnito para ver lo que verá esa persona.

## Correos de "Olvidé mi contraseña"
Supabase los manda con su servidor de correo de prueba, que solo envía unos pocos por hora. Si el equipo crece, configura un servidor propio en **Authentication > Emails > SMTP Settings**, por ejemplo Resend o el correo de Google Workspace. Las invitaciones no dependen del correo: son enlaces que copias y envías tú.

## Probar en tu computador
```bash
cp .env.example .env.local   # y llena los valores
npm install
npm run dev                  # http://localhost:3000
```

## Archivos
| Archivo | Qué es |
|---|---|
| `public/app.html` | La aplicación: tablero, cronograma, hitos, equipo, proyectos |
| `public/shim.js` | Conecta la app con Supabase (datos en vivo, sesión, archivos) |
| `public/login.html`, `public/aceptar.html`, `public/auth.css` | Ingreso y creación de contraseña |
| `app/api/config/route.js` | Entrega la URL y la llave pública de Supabase al navegador |
| `app/api/invite/route.js` | Crea invitaciones; solo responde a la administradora |
| `supabase/1-esquema.sql` | Tablas, permisos, archivos y cambios en vivo |
| `supabase/2-migracion-datos.sql` | Tus datos actuales |

## Notas
- Los archivos adjuntos van al bucket `files` de Supabase. Se admite cualquier tipo, hasta 50 MB. Cada archivo se abre con un enlace largo imposible de adivinar, pero quien tenga ese enlace puede abrirlo.
- Los archivos que se habían subido en la versión de claude.ai no se migran, solo los enlaces. Esa versión no tenía archivos subidos.
