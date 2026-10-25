-- Variante "columnar" de public.ejecutar_sql_argomedo: mismas sentencias, misma transacción, pero las consultas devuelven los datos como
-- { cols: [nombres], rows: [[valores], ...], rowCount } en vez de un objeto por fila. Los nombres de las columnas viajan una sola vez
-- (no en cada fila): con los productos el resultado pesa ≈44 % menos. El servidor reconstruye los objetos al recibirlos, así
-- que el resto del código no cambia. Es una función NUEVA: ejecutar_sql_argomedo sigue igual y sirve de respaldo.
-- Las sentencias que no son consultas (INSERT/UPDATE/DELETE sin RETURNING) devuelven { rows: [], rowCount }, igual que antes.
-- Seguridad: solo la llave "service_role" (secreta, guardada en el servidor) puede ejecutarla.
create or replace function public.ejecutar_sql_col_argomedo(sentencias jsonb)
returns jsonb
language plpgsql
security definer
set search_path = argomedo455, public
as $$
declare
  s text;
  res jsonb := '[]'::jsonb;
  filas jsonb;
  cols jsonb;
  n bigint;
begin
  for s in select jsonb_array_elements_text(sentencias) loop
    if s ~* '^\s*(select|with|values|table)\M' then
      execute 'select coalesce(jsonb_agg(__t), ''[]''::jsonb) from (' || s || ') __t' into filas;
    elsif s ~* '\mreturning\M' then
      execute 'with __t as (' || s || ') select coalesce(jsonb_agg(__t), ''[]''::jsonb) from __t' into filas;
    else
      execute s;
      get diagnostics n = row_count;
      res := res || jsonb_build_array(jsonb_build_object('rows', '[]'::jsonb, 'rowCount', n));
      continue;
    end if;
    n := jsonb_array_length(filas);
    if n = 0 then
      res := res || jsonb_build_array(jsonb_build_object('cols', '[]'::jsonb, 'rows', '[]'::jsonb, 'rowCount', 0));
    else
      -- Las columnas salen de la primera fila (todas las filas traen las mismas, en el mismo orden); los valores van en ese orden.
      select coalesce(jsonb_agg(k order by o), '[]'::jsonb) into cols from jsonb_object_keys(filas -> 0) with ordinality as t(k, o);
      res := res || jsonb_build_array(jsonb_build_object(
        'cols', cols,
        'rows', (select jsonb_agg((select jsonb_agg(f -> c.k order by c.o) from jsonb_array_elements_text(cols) with ordinality as c(k, o))) from jsonb_array_elements(filas) as f),
        'rowCount', n));
    end if;
  end loop;
  return res;
end;
$$;
revoke all on function public.ejecutar_sql_col_argomedo(jsonb) from public, anon, authenticated;
grant execute on function public.ejecutar_sql_col_argomedo(jsonb) to service_role;
