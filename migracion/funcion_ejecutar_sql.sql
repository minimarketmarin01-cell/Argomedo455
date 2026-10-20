-- Función que el servidor llama por HTTPS (Supabase REST) para ejecutar SQL en la base.
-- Recibe un arreglo de sentencias y las corre TODAS en una sola transacción (si una falla, ninguna queda).
-- Devuelve un arreglo con { rows, rowCount } por sentencia.
-- Seguridad: solo la llave "service_role" (secreta, guardada en el servidor) puede ejecutarla.
create or replace function public.ejecutar_sql_argomedo(sentencias jsonb)
returns jsonb
language plpgsql
security definer
set search_path = argomedo455, public
as $$
declare
  s text;
  res jsonb := '[]'::jsonb;
  filas jsonb;
  n bigint;
begin
  for s in select jsonb_array_elements_text(sentencias) loop
    if s ~* '^\s*(select|with|values|table)\M' then
      execute 'select coalesce(jsonb_agg(__t), ''[]''::jsonb) from (' || s || ') __t' into filas;
      n := jsonb_array_length(filas);
    elsif s ~* '\mreturning\M' then
      execute 'with __t as (' || s || ') select coalesce(jsonb_agg(__t), ''[]''::jsonb) from __t' into filas;
      n := jsonb_array_length(filas);
    else
      execute s;
      get diagnostics n = row_count;
      filas := '[]'::jsonb;
    end if;
    res := res || jsonb_build_array(jsonb_build_object('rows', filas, 'rowCount', n));
  end loop;
  return res;
end;
$$;
revoke all on function public.ejecutar_sql_argomedo(jsonb) from public, anon, authenticated;
grant execute on function public.ejecutar_sql_argomedo(jsonb) to service_role;
